import "server-only";
import { randomUUID } from "node:crypto";
import prisma from "../prisma";
import { recordAudit, type AuditTxClient } from "../auth/audit";
import { lookupCuit, type CuitLookupResult, type LookupDeps } from "./service";
import { productionLookupEnabled } from "./production-switch";
import { arcaQuotaRules, postgresQuotaStore, type QuotaStore } from "./quota-store";
import { ARCA_LOOKUP_AUDIT_TARGET } from "./lookup-audit";

/**
 * Consulta a ARCA en producción, después de autenticación, organización, rol
 * y validación del CUIT (los hace el handler). Orden:
 *   interruptor + habilitación de la organización
 *   -> UNA transacción: cupos (todos o ninguno) + registro del intento
 *   -> ARCA (sin transacción abierta) -> registro del resultado.
 * Si no se puede leer la habilitación, consumir los cupos o registrar el
 * intento, no se consulta. Si falla el registro del resultado, el intento queda
 * registrado, no se entrega el dato y no se repite la consulta.
 *
 * Intento y resultado comparten `targetId` = identificador interno aleatorio
 * de la consulta (targetType ArcaPadronLookup); nunca el CUIT.
 */
export type ProductionLookupOutcome =
    | { kind: "LOOKUP"; result: CuitLookupResult }
    | { kind: "NOT_ENABLED" }
    | { kind: "CONTROL_UNAVAILABLE" }
    | { kind: "QUOTA_UNAVAILABLE" }
    | { kind: "RATE_LIMITED"; retryAfterSeconds: number }
    | { kind: "AUDIT_UNAVAILABLE" };

export interface LookupAuditEntry {
    organizationId: string;
    profileId: string;
    lookupId: string;
    result: string;
}

export interface ProductionLookupIo {
    enabled(organizationId: string): Promise<boolean>;
    quotas: QuotaStore;
    /** Escribe con el cliente dado: la transacción de cupos (intento) o el cliente normal (resultado). */
    audit(db: AuditTxClient, entry: LookupAuditEntry): Promise<void>;
    resultDb: AuditTxClient;
    lookup(cuit: string, deps: LookupDeps): Promise<CuitLookupResult>;
    newLookupId(): string;
}

export function auditResultOf(result: CuitLookupResult): string {
    return result.status === "ERROR" ? `ERROR_${result.code}` : result.status;
}

export function recordLookupAudit(db: AuditTxClient, { organizationId, profileId, lookupId, result }: LookupAuditEntry): Promise<void> {
    return recordAudit(db, {
        organizationId,
        actorProfileId: profileId,
        action: "arca.cuit_lookup",
        targetType: ARCA_LOOKUP_AUDIT_TARGET,
        targetId: lookupId,
        metadata: { result },
    });
}

export function defaultProductionIo(): ProductionLookupIo {
    return {
        enabled: (organizationId) => productionLookupEnabled(organizationId),
        quotas: postgresQuotaStore(),
        audit: recordLookupAudit,
        resultDb: prisma,
        lookup: (cuit, deps) => lookupCuit(cuit, deps),
        newLookupId: () => randomUUID(),
    };
}

export async function productionLookup(
    input: { profileId: string; organizationId: string; cuit: string },
    deps: LookupDeps,
    io: ProductionLookupIo = defaultProductionIo(),
): Promise<ProductionLookupOutcome> {
    if (!deps.production || !deps.config.configured) return { kind: "NOT_ENABLED" };
    try {
        if (!(await io.enabled(input.organizationId))) return { kind: "NOT_ENABLED" };
    } catch {
        return { kind: "CONTROL_UNAVAILABLE" };
    }
    const base = { organizationId: input.organizationId, profileId: input.profileId, lookupId: io.newLookupId() };
    let decision;
    try {
        decision = await io.quotas.consume(
            arcaQuotaRules({ profileId: input.profileId, organizationId: input.organizationId, certificateKey: deps.production.certificateKey }, deps.production.quotas),
            (tx) => io.audit(tx, { ...base, result: "STARTED" }),
        );
    } catch {
        return { kind: "QUOTA_UNAVAILABLE" };
    }
    if (!decision.ok) return { kind: "RATE_LIMITED", retryAfterSeconds: Math.max(1, Math.ceil(decision.retryAfterMs / 1000)) };
    const result = await io.lookup(input.cuit, deps);
    try {
        await io.audit(io.resultDb, { ...base, result: auditResultOf(result) });
    } catch {
        return { kind: "AUDIT_UNAVAILABLE" };
    }
    return { kind: "LOOKUP", result };
}
