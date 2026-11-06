import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import defaultPrisma from "../prisma";
import { DEFAULT_PERIOD_VAT_SETTINGS, legacyColumnsFor, type InvoiceModelData, type PeriodVatSettingsLike } from "../invoice-model";
import { ConflictError, NotFoundError, ValidationError } from "../auth/errors";
import { parseLidFile, type LidCategory } from "./format";
import { buildImportPreview, voucherKey, type ImportPreview, type ImportSource, type SectionTotals } from "./build";
import { parsePortalDownload } from "./portal-csv";
import { parseMisComprobantes } from "./mis-comprobantes-csv";
import { recordAudit } from "../auth/audit";
import { isAuthError } from "../auth/errors";
import type { ImportOperationView, OperationResult } from "./operation";

/**
 * Importación del Libro IVA Digital: vista previa y confirmación.
 *
 * Sin estado entre ambas: la confirmación vuelve a recibir los MISMOS archivos
 * y el `token` de la vista previa; se recalcula todo y, si el resultado no es
 * idéntico (otro usuario cargó comprobantes, cambió la configuración del
 * período, etc.), se rechaza (409) para que el operador vuelva a revisar.
 * La escritura ocurre en la ruta de confirmación, bajo el bloqueo del Period
 * (lockPeriodForWrite): un período cerrado entre la vista previa y la
 * confirmación se rechaza (409 PERIOD_CLOSED) y no se escribe nada. Este módulo
 * sólo lee.
 *
 * `organizationId`, `periodId` y `clientId` llegan YA autorizados por la ruta
 * (requirePeriodAccess con expectClientId). Toda lectura filtra por organización.
 */

type Db = Pick<PrismaClient, "period" | "periodVatSettings" | "invoice" | "$transaction">;
type AuditReadDb = Pick<PrismaClient, "auditLog"> | Prisma.TransactionClient;

export interface ImportScope {
    organizationId: string;
    periodId: string;
    clientId: string;
}

export interface ImportFiles {
    category: LidCategory;
    /** LID_TXT (por defecto): par comprobantes + alícuotas. PORTAL_CSV: la descarga de Portal IVA (CSV o ZIP) en `vouchers`. */
    format?: ImportSource;
    vouchers: Uint8Array;
    /** Sólo LID_TXT. */
    aliquots: Uint8Array;
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

async function existingKeys(db: Pick<PrismaClient, "invoice"> | Prisma.TransactionClient, scope: ImportScope, category: LidCategory): Promise<Set<string>> {
    const rows = await db.invoice.findMany({
        where: { organizationId: scope.organizationId, clientId: scope.clientId, category, voucherCode: { not: null } },
        select: { voucherCode: true, pointOfSale: true, number: true, counterpartyDocType: true, counterpartyDocNumber: true },
    });
    return new Set(rows.map((r) => voucherKey({
        category, voucherCode: r.voucherCode as number, pointOfSale: r.pointOfSale, number: r.number,
        counterpartyDocType: r.counterpartyDocType, counterpartyDocNumber: r.counterpartyDocNumber,
    })));
}

export interface PreviewResult {
    preview: ImportPreview;
    token: string;
    periodOpen: boolean;
    vouchersSha256: string;
    aliquotsSha256: string;
    format: ImportSource;
}

export async function previewImport(scope: ImportScope, files: ImportFiles, db: Db = defaultPrisma): Promise<PreviewResult> {
    const period = await db.period.findFirst({
        where: { id: scope.periodId, organizationId: scope.organizationId, clientId: scope.clientId },
        select: { month: true, year: true, status: true, client: { select: { cuit: true } } },
    });
    if (!period) throw new NotFoundError();
    const settingsRow = await db.periodVatSettings.findUnique({
        where: { periodId_organizationId: { periodId: scope.periodId, organizationId: scope.organizationId } },
        select: { creditProrationMode: true, globalCoefficient: true, globalCoefficientStatus: true, turivaIncluded: true },
    });
    const settings: PeriodVatSettingsLike = settingsRow ?? DEFAULT_PERIOD_VAT_SETTINGS;
    const ctx = { category: files.category, period, settings, existingKeys: await existingKeys(db, scope, files.category) };
    const format: ImportSource = files.format ?? "LID_TXT";
    let preview: ImportPreview;
    if (format === "PORTAL_CSV") {
        const portal = parsePortalDownload(files.vouchers, files.category);
        preview = buildImportPreview({ ...ctx, source: "PORTAL_CSV" }, portal.vouchers, portal.aliquots, { fileErrors: portal.fileErrors, rowNotes: portal.totalColumnNotes });
    } else if (format === "MIS_COMPROBANTES") {
        const mc = parseMisComprobantes(files.vouchers, files.category, period.client.cuit.replace(/\D/g, ""));
        preview = buildImportPreview({ ...ctx, source: "MIS_COMPROBANTES" }, mc.vouchers, mc.aliquots, { fileErrors: mc.fileErrors, rowNotes: mc.rowNotes });
    } else {
        preview = buildImportPreview(ctx, parseLidFile(files.vouchers, files.category, "VOUCHERS"), parseLidFile(files.aliquots, files.category, "ALIQUOTS"));
    }
    const vouchersSha256 = sha256(files.vouchers), aliquotsSha256 = sha256(files.aliquots);
    const token = sha256(JSON.stringify({
        v: 1, ...scope, category: files.category, format, vouchersSha256, aliquotsSha256,
        settings: [settings.creditProrationMode, settings.turivaIncluded],
        rows: preview.rows.map((r) => [r.line, r.status, r.key]),
        fileErrors: preview.fileErrors,
    }));
    return { preview, token, periodOpen: period.status === "OPEN", vouchersSha256, aliquotsSha256, format };
}

export const STALE_PREVIEW_MESSAGE = "La vista previa ya no coincide con el estado del período o con los archivos: generala de nuevo antes de confirmar.";
export const PARTIAL_IMPORT_MESSAGE = "Hay filas con errores o para revisar que no se importarán: confirmá la importación parcial o corregí los archivos.";

export interface ConfirmResult {
    imported: number;
    turiva: number;
    duplicates: number;
    notImported: number;
}

/** Columnas de Invoice para un comprobante importado (mismo mapeo que la carga manual). */
export function importedInvoiceColumns(m: InvoiceModelData, scope: ImportScope) {
    const legacy = legacyColumnsFor(m);
    return {
        date: legacy.date, type: legacy.type, pointOfSale: m.pointOfSale, number: m.number, entityName: legacy.entityName,
        entityCuit: legacy.entityCuit, netAmount: legacy.netAmount, vatRate: legacy.vatRate, vatAmount: legacy.vatAmount,
        totalAmount: legacy.totalAmount, category: m.category, periodId: scope.periodId, organizationId: scope.organizationId,
        clientId: scope.clientId, source: "IMPORT" as const, voucherCode: m.voucherCode, numberTo: m.number, voucherDate: m.voucherDate,
        counterpartyDocType: m.counterpartyDocType, counterpartyDocNumber: m.counterpartyDocNumber, counterpartyName: m.counterpartyName,
        currencyCode: m.currencyCode, exchangeRate: m.exchangeRate, taxedNetAmount: m.taxedNetAmount, totalVatAmount: m.totalVatAmount,
        directComputableVatCreditAmount: m.directComputableVatCreditAmount, reportedComputableVatCreditAmount: m.reportedComputableVatCreditAmount,
        netWithoutVatBreakdownAmount: m.netWithoutVatBreakdownAmount, nonTaxedAmount: m.nonTaxedAmount, exemptAmount: m.exemptAmount,
        vatPerceptionAmount: m.vatPerceptionAmount, nationalPerceptionAmount: m.nationalPerceptionAmount, iibbPerceptionAmount: m.iibbPerceptionAmount,
        municipalPerceptionAmount: m.municipalPerceptionAmount, internalTaxesAmount: m.internalTaxesAmount, otherTaxesAmount: m.otherTaxesAmount,
        grossIncomeTaxBaseAmount: m.grossIncomeTaxBaseAmount, voucherTotalAmount: m.voucherTotalAmount, turivaRefundAmount: m.turivaRefundAmount,
        lidSection: m.lidSection, operationCode: m.operationCode,
        // El Libro IVA Digital no informa condición fiscal de la contraparte, relación TurIVA ni variante.
        counterpartyVatConditionCode: null, turivaRelationCode: null, voucherVariant: null,
        vatLines: {
            create: m.vatLines.map((l) => ({
                vatRateCode: l.vatRateCode, netAmount: l.netAmount, vatAmount: l.vatAmount, creditAllocation: l.creditAllocation,
                computableVatAmount: l.computableVatAmount, computableOverridden: l.computableOverridden,
            })),
        },
    };
}

export interface ConfirmPlan {
    rows: { key: string; model: InvoiceModelData }[];
    result: ConfirmResult;
    category: LidCategory;
    statusCounts: ImportPreview["reconciliation"]["statusCounts"];
    format: ImportSource;
    vouchersSha256: string;
    aliquotsSha256: string;
}

/**
 * Prepara la confirmación SIN escribir: recalcula la vista previa con los
 * mismos archivos y exige el mismo token, sin errores de archivo, al menos una
 * fila OK y, si hay filas para revisar o con error, la aceptación expresa de
 * la importación parcial. La escritura (bajo lockPeriodForWrite) la hace la
 * ruta de confirmación, que es el handler inventariado.
 */
export async function planConfirm(
    scope: ImportScope,
    files: ImportFiles,
    opts: { token: string; acceptPartial: boolean },
    db: Db = defaultPrisma,
): Promise<ConfirmPlan> {
    const fresh = await previewImport(scope, files, db);
    if (fresh.token !== opts.token) throw new ConflictError(STALE_PREVIEW_MESSAGE);
    const { preview } = fresh;
    if (preview.fileErrors.length > 0) throw new ValidationError("los archivos tienen problemas que impiden confirmar: " + preview.fileErrors[0], "files");
    const rows = preview.rows.flatMap((r) => (r.status === "OK" && r.model !== null && r.key !== null ? [{ key: r.key, model: r.model }] : []));
    if (rows.length === 0) throw new ValidationError("no hay comprobantes para importar", "files");
    const counts = preview.reconciliation.statusCounts;
    if (counts.ERROR + counts.REVIEW > 0 && opts.acceptPartial !== true) throw new ValidationError(PARTIAL_IMPORT_MESSAGE, "acceptPartial");
    const turiva = rows.filter((r) => r.model.lidSection === "TURIVA").length;
    return {
        rows,
        category: files.category,
        format: fresh.format,
        statusCounts: counts,
        vouchersSha256: fresh.vouchersSha256,
        aliquotsSha256: fresh.aliquotsSha256,
        result: { imported: rows.length, turiva, duplicates: counts.DUPLICATE, notImported: counts.ERROR + counts.REVIEW },
    };
}

/** Claves ya cargadas (para releer bajo el bloqueo del período). */
export { existingKeys as importedVoucherKeys };

/**
 * Datos de escritura de los comprobantes del plan: filas de Invoice (sin
 * anidar) y de InvoiceVatLine, con ids generados acá para escribir en dos
 * createMany dentro de la misma transacción. Mismo mapeo que la carga manual.
 */
export function importWriteData(plan: ConfirmPlan, scope: ImportScope, profileId: string) {
    const invoices: Prisma.InvoiceCreateManyInput[] = [];
    const vatLines: Prisma.InvoiceVatLineCreateManyInput[] = [];
    for (const r of plan.rows) {
        const id = "c" + randomBytes(12).toString("hex");
        const { vatLines: lines, ...columns } = importedInvoiceColumns(r.model, scope);
        invoices.push({ ...columns, id, createdById: profileId, updatedById: profileId });
        for (const l of lines.create) vatLines.push({ ...l, invoiceId: id, organizationId: scope.organizationId });
    }
    return { invoices, vatLines };
}

/** Metadatos del AuditLog invoice.import: conteos, huellas y operationId; sin CUIT, nombres ni importes. */
export function importAuditMetadata(plan: ConfirmPlan, scope: ImportScope, operationId: string) {
    return {
        periodId: scope.periodId, category: plan.category, format: plan.format, importedCount: plan.result.imported, turivaCount: plan.result.turiva,
        duplicateCount: plan.statusCounts.DUPLICATE, reviewCount: plan.statusCounts.REVIEW, errorCount: plan.statusCounts.ERROR,
        vouchersFileSha256: plan.vouchersSha256, aliquotsFileSha256: plan.aliquotsSha256, operationId,
    };
}

// ── Resultado de cada confirmación (operationId), desde el AuditLog ──

const IMPORT_ACTIONS = ["invoice.import", "invoice.import.failed"];

type AuditRow = { action: string; metadata: Prisma.JsonValue; createdAt: Date };

const metaOf = (r: AuditRow): Record<string, unknown> => (r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata) ? (r.metadata as Record<string, unknown>) : {});
const num = (v: unknown) => (typeof v === "number" ? v : 0);
const str = (v: unknown) => (typeof v === "string" ? v : null);

/** Resultado guardado en una fila invoice.import (mismo cálculo que planConfirm). */
export function appliedResult(meta: Record<string, unknown>): OperationResult {
    return { imported: num(meta.importedCount), turiva: num(meta.turivaCount), duplicates: num(meta.duplicateCount), notImported: num(meta.reviewCount) + num(meta.errorCount) };
}

function viewOf(operationId: string, rows: AuditRow[]): ImportOperationView {
    const applied = rows.find((r) => r.action === "invoice.import");
    const failed = rows.find((r) => r.action === "invoice.import.failed");
    const pick = applied ?? failed;
    if (!pick) return { operationId, status: "NOT_FOUND", at: null, category: null, format: null, result: null, failure: null };
    const m = metaOf(pick);
    return {
        operationId,
        status: applied ? "APPLIED" : "FAILED",
        at: pick.createdAt.toISOString(),
        category: str(m.category),
        format: str(m.format),
        result: applied ? appliedResult(m) : null,
        failure: applied ? null : { code: str(m.code) ?? "INTERNAL", httpStatus: typeof m.httpStatus === "number" ? m.httpStatus : null },
    };
}

const opWhere = (scope: ImportScope) => ({ organizationId: scope.organizationId, targetType: "Period", targetId: scope.periodId, action: { in: IMPORT_ACTIONS } });

/**
 * Estado de una operación del período, filtrado por organización y período
 * (ya autorizados por la ruta). APPLIED tiene prioridad sobre FAILED: un
 * reintento exitoso de la misma operación la deja aplicada.
 */
export async function findImportOperation(db: AuditReadDb, scope: ImportScope, operationId: string): Promise<ImportOperationView & { meta: Record<string, unknown> | null }> {
    const rows = await db.auditLog.findMany({
        where: { ...opWhere(scope), metadata: { path: ["operationId"], equals: operationId } },
        select: { action: true, metadata: true, createdAt: true },
        orderBy: { createdAt: "desc" },
    });
    const applied = rows.find((r) => r.action === "invoice.import");
    const failedAttemptIds = rows.filter((r) => r.action === "invoice.import.failed").map((r) => str(metaOf(r).attemptId)).filter((v): v is string => v !== null);
    return { ...viewOf(operationId, rows), failedAttemptIds, meta: applied ? metaOf(applied) : null };
}

/** Vista para la API, sin los metadatos crudos (huellas de archivos). */
export function publicOperationView(v: ImportOperationView & { meta?: unknown }): ImportOperationView {
    return { operationId: v.operationId, status: v.status, at: v.at, category: v.category, format: v.format, result: v.result, failure: v.failure, failedAttemptIds: v.failedAttemptIds ?? [] };
}

/** Últimas confirmaciones registradas del período (aplicadas y fallidas). */
export async function listImportOperations(db: AuditReadDb, scope: ImportScope, take = 10): Promise<ImportOperationView[]> {
    const rows = await db.auditLog.findMany({ where: opWhere(scope), select: { action: true, metadata: true, createdAt: true }, orderBy: { createdAt: "desc" }, take });
    return rows.map((r) => viewOf(str(metaOf(r).operationId) ?? "", [r]));
}

/** Huellas de los archivos recibidos, para comparar un reintento con la operación ya aplicada. */
export function requestFileHashes(files: ImportFiles) {
    return { vouchersSha256: sha256(files.vouchers), aliquotsSha256: sha256(files.aliquots) };
}

/** ¿El reintento trae lo mismo que la operación aplicada? */
export function sameOperation(meta: Record<string, unknown>, files: ImportFiles): boolean {
    const h = requestFileHashes(files);
    return meta.category === files.category && meta.format === (files.format ?? "LID_TXT") && meta.vouchersFileSha256 === h.vouchersSha256 && meta.aliquotsFileSha256 === h.aliquotsSha256;
}

export const OPERATION_REUSED_MESSAGE = "Ese identificador de operación ya se usó con otros archivos: generá la vista previa de nuevo.";

/**
 * Registra que la confirmación terminó con error (la transacción ya se
 * revirtió o no llegó a empezar): sólo operationId, attemptId (si vino),
 * libro, formato y código.
 * Best-effort: si no se puede escribir, no oculta el error original.
 */
export async function recordImportFailure(db: Pick<PrismaClient, "auditLog">, scope: ImportScope, actorProfileId: string, files: ImportFiles, operationId: string, err: unknown, attemptId: string | null = null): Promise<void> {
    const code = isAuthError(err) ? err.code : err instanceof Prisma.PrismaClientKnownRequestError ? err.code : "INTERNAL";
    const httpStatus = isAuthError(err) ? err.status : 500;
    try {
        await recordAudit(db, {
            organizationId: scope.organizationId,
            actorProfileId,
            action: "invoice.import.failed",
            targetType: "Period",
            targetId: scope.periodId,
            metadata: { operationId, ...(attemptId ? { attemptId } : {}), periodId: scope.periodId, category: files.category, format: files.format ?? "LID_TXT", code, httpStatus },
        });
    } catch (e) {
        console.info("[libro-iva-import] no se pudo registrar la falla: " + (e instanceof Error ? e.name : typeof e));
    }
}

// ── Serialización para la API (importes como string exacto; sin clave ni modelo) ──

const totalsJson = (t: SectionTotals) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, typeof v === "number" ? v : (v as Prisma.Decimal).toFixed(2)]));

export function serializePreview(r: PreviewResult) {
    const p = r.preview;
    return {
        token: r.token,
        periodOpen: r.periodOpen,
        format: r.format,
        category: p.category,
        turivaFile: p.turivaFile,
        fileErrors: p.fileErrors,
        rows: p.rows.map((row) => ({
            line: row.line, aliquotLines: row.aliquotLines, status: row.status, messages: row.messages,
            warnings: [...row.warnings.map((w) => w.message), ...row.notes], voucherCode: row.voucherCode, pointOfSale: row.pointOfSale,
            number: row.number, date: row.date, docType: row.docType, docNumber: row.docNumber, name: row.name, section: row.section,
            informedTotal: row.informedTotal?.toFixed(2) ?? null,
            taxedNet: row.model?.taxedNetAmount.toFixed(2) ?? null, vat: row.model?.totalVatAmount.toFixed(2) ?? null,
            total: row.model?.voucherTotalAmount.toFixed(2) ?? null, aliquots: row.model?.vatLines.length ?? null,
        })),
        reconciliation: {
            files: p.reconciliation.files,
            informed: Object.fromEntries(Object.entries(p.reconciliation.informed).map(([k, v]) => [k, v.toFixed(2)])),
            statusCounts: p.reconciliation.statusCounts,
            importable: {
                GENERAL: totalsJson(p.reconciliation.importable.GENERAL),
                TURIVA: totalsJson(p.reconciliation.importable.TURIVA),
                CONSOLIDATED: totalsJson(p.reconciliation.importable.CONSOLIDATED),
            },
            byRate: Object.fromEntries(Object.entries(p.reconciliation.byRate).map(([k, v]) => [k, { net: v.net.toFixed(2), vat: v.vat.toFixed(2) }])),
            byVoucherType: p.reconciliation.byVoucherType.map((t) => ({ ...t, informedTotal: t.informedTotal.toFixed(2), signedTotal: t.signedTotal.toFixed(2) })),
            notImported: {
                REVIEW: totalsJson(p.reconciliation.notImported.REVIEW),
                DUPLICATE: totalsJson(p.reconciliation.notImported.DUPLICATE),
                ERROR: { count: p.reconciliation.notImported.ERROR.count, informedTotal: p.reconciliation.notImported.ERROR.informedTotal.toFixed(2) },
                reviewWithoutModel: p.reconciliation.notImported.reviewWithoutModel,
            },
            signBridge: {
                unsignedTotal: p.reconciliation.signBridge.unsignedTotal.toFixed(2),
                creditNotesTotal: p.reconciliation.signBridge.creditNotesTotal.toFixed(2),
                creditNotesCount: p.reconciliation.signBridge.creditNotesCount,
                signedTotal: p.reconciliation.signBridge.signedTotal.toFixed(2),
            },
        },
    };
}
