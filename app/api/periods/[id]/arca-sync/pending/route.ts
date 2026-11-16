import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requirePeriodAccess, withApiAuthz } from "@/lib/auth/authz";
import { ConflictError, ValidationError } from "@/lib/auth/errors";
import { ROLES_CREATE } from "@/lib/auth/roles";
import { importerInvoke } from "@/lib/arca-sync/importer-invoke";
import { invoiceBody } from "@/lib/arca-sync/preview-run";
import { reasonKey, type SyncPreviewSummary } from "@/lib/arca-sync/preview";
import { CORRECTABLE_AMOUNTS } from "@/lib/libro-iva-import/build";
import { parseMisComprobantes } from "@/lib/libro-iva-import/mis-comprobantes-csv";
import { parsePortalDownload } from "@/lib/libro-iva-import/portal-csv";

type Context = { params: Promise<{ id: string }> };

/** Tope de filas por respuesta: el panel las muestra agrupadas por motivo. */
const ROW_LIMIT = 3000;

interface PreviewRowJson {
    line: number; status: string; messages: string[]; voucherCode: number | null; pointOfSale: number | null; number: number | null;
    date: string | null; docType: number | null; docNumber: string | null; name: string | null; informedTotal: string | null;
}

// GET /api/periods/[id]/arca-sync/pending?source=SALES|PURCHASES&legend=1
// Filas pendientes de la última descarga de ARCA de esa fuente, recalculadas con
// el importador existente y las correcciones guardadas, para revisarlas y
// corregirlas. Lee el archivo guardado; no escribe nada.
export const GET = withApiAuthz(async (request: Request, context: Context) => {
    const { id } = await context.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { period } = await requirePeriodAccess(profileId, id, ROLES_CREATE);
    const url = new URL(request.url);
    const source = url.searchParams.get("source");
    if (source !== "SALES" && source !== "PURCHASES") throw new ValidationError("Fuente inválida.", "source");

    const latest = await prisma.arcaSyncTask.findFirst({ where: { periodId: id }, orderBy: { createdAt: "desc" }, select: { runKey: true } });
    const task = latest && await prisma.arcaSyncTask.findUnique({
        where: { periodId_runKey_source: { periodId: id, runKey: latest.runKey, source } },
        select: { id: true, status: true, preview: true, files: { orderBy: { position: "asc" } } },
    });
    if (!task?.preview || !task.files.length) {
        throw new ConflictError("El archivo de esa fuente ya no está guardado: volvé a importar desde ARCA para revisar sus pendientes.");
    }
    const summary = task.preview as unknown as SyncPreviewSummary;
    const legendParam = url.searchParams.get("legend");
    const legend = source === "SALES" && (legendParam === null
        ? (summary.consumerFinalApplied ?? summary.confirmed?.consumerFinalLegend) === true
        : legendParam === "1");

    const stored = task.files[0];
    const file = { content: new Uint8Array(stored.content), format: stored.format, sha256: stored.sha256 };
    const response = await importerInvoke(request.url, id)("INVOICE_PREVIEW", invoiceBody({ source, clientId: period.clientId }, file, legend, summary.corrections));
    if (!response.ok) throw new ConflictError("El importador no pudo recalcular las filas pendientes.");
    const preview = response.data as { rows: PreviewRowJson[] };

    // Importes de cabecera del archivo, para corregir el concepto que la descarga no detalla.
    const client = await prisma.client.findUnique({ where: { id: period.clientId }, select: { cuit: true } });
    const parsed = stored.format === "MIS_COMPROBANTES"
        ? parseMisComprobantes(file.content, source, client?.cuit.replace(/\D/g, "") ?? null).vouchers.records
        : parsePortalDownload(file.content, source).vouchers.records;
    const amountsByLine = new Map(parsed.map((record) => [record.line, Object.fromEntries(CORRECTABLE_AMOUNTS.map((field) => {
        const value = record.values[field] as { toFixed?: (digits: number) => string } | undefined;
        return [field, typeof value?.toFixed === "function" ? value.toFixed(2) : "0.00"];
    }))]));

    const pending = preview.rows.filter((row) => row.status === "REVIEW" || row.status === "ERROR");
    return NextResponse.json({
        source, legend, corrections: summary.corrections ?? null, total: pending.length, truncated: pending.length > ROW_LIMIT,
        rows: pending.slice(0, ROW_LIMIT).map((row) => ({
            line: row.line, status: row.status, reasons: row.messages.map(reasonKey), messages: row.messages,
            voucherCode: row.voucherCode, pointOfSale: row.pointOfSale, number: row.number, date: row.date,
            docType: row.docType, docNumber: row.docNumber, name: row.name, informedTotal: row.informedTotal,
            amounts: amountsByLine.get(row.line) ?? null,
        })),
    }, { headers: { "Cache-Control": "no-store" } });
});
