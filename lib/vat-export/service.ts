import "server-only";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { MissingGlobalProrationCoefficientError } from "../invoice-model";
import { computeLiquidation, type LiquidationResult } from "../liquidation-calc";
import { serializeLiquidation, type LiquidationDTO } from "../serializers";
import type { ExportIssue, IssueCode, IssueLevel } from "./classification";
import { contentHash, loadPeriodExportData, type PeriodExportData } from "./load";
import { buildPackage, hasExportBlockers, periodExportIssues, type PackageFileInfo, type PackageResult, type ReconciliationLine } from "./package";
import type { OmittedFile } from "./types";
import { VAT_EXPORT_ENGINE_VERSION } from "./version";

/**
 * Punto único para borrador, controles y cierre: la MISMA carga
 * (loadPeriodExportData), el MISMO motor (computeLiquidation, también usado
 * por la pantalla y el Excel) y el MISMO armador del paquete.
 */

type Db = Pick<PrismaClient, "period" | "invoice">;

export interface Readiness {
    liquidation: LiquidationDTO | null;
    liquidationError: string | null;
    issues: ExportIssue[];
    counts: Record<IssueLevel, number>;
    byCode: { code: IssueCode; level: IssueLevel; count: number; example: string }[];
    blocked: boolean;
    contentHash: string;
}

function liquidate(data: PeriodExportData): { result: LiquidationResult | null; error: string | null } {
    try {
        return { result: computeLiquidation(data.calc), error: null };
    } catch (e) {
        if (e instanceof MissingGlobalProrationCoefficientError) return { result: null, error: e.message };
        throw e;
    }
}

export function readinessOf(data: PeriodExportData): Readiness {
    const { result, error } = liquidate(data);
    const issues = periodExportIssues(data.invoices, data.taxRecords, data.settings);
    if (error) issues.unshift({ level: "LIQUIDATION", code: "LIQUIDATION_NOT_COMPUTABLE", message: error });
    const counts: Record<IssueLevel, number> = { LIQUIDATION: 0, EXPORT: 0, WARNING: 0, INFO: 0 };
    const by = new Map<string, { code: IssueCode; level: IssueLevel; count: number; example: string }>();
    for (const i of issues) {
        counts[i.level]++;
        const k = `${i.level}|${i.code}`;
        const cur = by.get(k);
        if (cur) cur.count++;
        else by.set(k, { code: i.code, level: i.level, count: 1, example: i.message });
    }
    return {
        liquidation: result ? serializeLiquidation(result) : null,
        liquidationError: error,
        issues,
        counts,
        byCode: [...by.values()],
        blocked: error !== null || hasExportBlockers(issues),
        contentHash: contentHash(data),
    };
}

export async function loadReadiness(db: Db, scope: { organizationId: string; periodId: string }): Promise<{ data: PeriodExportData; readiness: Readiness } | null> {
    const data = await loadPeriodExportData(db, scope);
    return data ? { data, readiness: readinessOf(data) } : null;
}

export function packageFor(data: PeriodExportData, liquidation: LiquidationResult, mode: "DRAFT" | "FINAL", version: number | null, now: Date): PackageResult {
    return buildPackage({
        mode,
        identity: { clientName: data.client.name, clientCuit: data.client.cuit, month: data.period.month, year: data.period.year },
        version,
        generatedAt: now,
        contentHash: contentHash(data),
        settings: data.settings,
        adjustments: data.adjustments,
        liquidation,
        invoices: data.invoices,
        taxRecords: data.taxRecords,
    });
}

/** Resumen guardado con la versión cerrada (JSON saneado: sin datos de contrapartes). */
export interface VersionSummary {
    engineVersion: string;
    identity: { clientName: string; clientCuit: string; month: number; year: number };
    liquidation: LiquidationDTO | null;
    liquidationError: string | null;
    counts: Record<IssueLevel, number>;
    blockers: { code: IssueCode; level: IssueLevel; count: number; example: string }[];
    invoiceCount: number;
    taxRecordCount: number;
    files: PackageFileInfo[];
    omitted: OmittedFile[];
    reconciliation: ReconciliationLine[];
}

export interface CloseSnapshot {
    contentHash: string;
    summary: VersionSummary;
    packageZip: Uint8Array | null;
    packageSha256: string | null;
}

/**
 * Datos de una versión cerrada, calculados BAJO el bloqueo del Period (la
 * transacción del cierre). Con bloqueos de exportación, la versión se guarda
 * sin paquete y con los bloqueos en el resumen.
 */
export async function closeSnapshot(tx: Db, scope: { organizationId: string; periodId: string }, version: number, now: Date): Promise<CloseSnapshot | null> {
    const data = await loadPeriodExportData(tx, scope);
    if (!data) return null;
    const r = readinessOf(data);
    const { result } = liquidate(data);
    let pkg: PackageResult | null = null;
    if (result && !r.blocked) pkg = packageFor(data, result, "FINAL", version, now);
    return {
        contentHash: r.contentHash,
        summary: {
            engineVersion: VAT_EXPORT_ENGINE_VERSION,
            identity: { clientName: data.client.name, clientCuit: data.client.cuit, month: data.period.month, year: data.period.year },
            liquidation: r.liquidation,
            liquidationError: r.liquidationError,
            counts: r.counts,
            blockers: r.byCode.filter((b) => b.level === "EXPORT" || b.level === "LIQUIDATION"),
            invoiceCount: data.invoices.length,
            taxRecordCount: data.taxRecords.length,
            files: pkg?.files ?? [],
            omitted: pkg?.omitted ?? [],
            reconciliation: pkg?.reconciliation ?? [],
        },
        packageZip: pkg?.zip ?? null,
        packageSha256: pkg ? createHash("sha256").update(pkg.zip).digest("hex") : null,
    };
}
