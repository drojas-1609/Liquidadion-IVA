import "server-only";
import prisma from "../prisma";

/**
 * Lectura de la auditoría de consultas a ARCA de UNA organización: un renglón
 * por intento (perfil, fecha) con su resultado, vinculado por el identificador
 * interno de la consulta; "SIN_RESULTADO" si no se registró el final. El
 * identificador de perfil es un dato personal seudónimo de usuarios del
 * estudio, no anónimo. Nunca hubo CUIT ni respuesta que devolver. La retención
 * es una decisión pendiente: no hay purga automática.
 */
/** targetType de la auditoría de consultas; targetId es el identificador interno de cada consulta. */
export const ARCA_LOOKUP_AUDIT_TARGET = "ArcaPadronLookup";

export interface LookupAuditRow {
    at: string;
    actorProfileId: string | null;
    result: string;
}
type AuditReader = Pick<typeof prisma, "auditLog">;
const resultOf = (metadata: unknown) => {
    const r = (metadata as Record<string, unknown> | null)?.result;
    return typeof r === "string" ? r : null;
};

export async function listLookupAudit(organizationId: string, db: AuditReader = prisma, take = 100): Promise<LookupAuditRow[]> {
    const rows = await db.auditLog.findMany({
        where: { organizationId, action: "arca.cuit_lookup", targetType: ARCA_LOOKUP_AUDIT_TARGET, metadata: { path: ["result"], equals: "STARTED" } },
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(1, take), 200),
        select: { createdAt: true, actorProfileId: true, targetId: true },
    });
    const finals = rows.length === 0 ? [] : await db.auditLog.findMany({
        where: { organizationId, action: "arca.cuit_lookup", targetType: ARCA_LOOKUP_AUDIT_TARGET, targetId: { in: rows.map((r) => r.targetId) }, NOT: { metadata: { path: ["result"], equals: "STARTED" } } },
        select: { targetId: true, metadata: true },
    });
    const byId = new Map(finals.map((f) => [f.targetId, resultOf(f.metadata)]));
    return rows.map((r) => ({ at: r.createdAt.toISOString(), actorProfileId: r.actorProfileId, result: byId.get(r.targetId) ?? "SIN_RESULTADO" }));
}
