import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { parseJsonBody, requireAuthenticatedProfile, requirePeriodAccess, withApiAuthz } from "@/lib/auth/authz";
import { ConflictError, ValidationError } from "@/lib/auth/errors";
import { ROLES_CREATE } from "@/lib/auth/roles";
import { ARCA_SYNC_SOURCES } from "@/lib/arca-sync/calendar";
import { importerInvoke } from "@/lib/arca-sync/importer-invoke";
import { confirmSyncPreview, ConfirmFailedError, ImportRejectedError, PreviewChangedError, type SyncSource } from "@/lib/arca-sync/preview-run";
import type { SyncPreviewSummary } from "@/lib/arca-sync/preview";
import { getSyncStatus } from "@/lib/arca-sync/service";

type Context = { params: Promise<{ id: string }> };

/** Una confirmación interrumpida se puede retomar pasado este tiempo. */
const CONFIRM_STALE_MS = 2 * 60 * 1000;
const json = (value: SyncPreviewSummary) => value as unknown as Prisma.InputJsonValue;

// POST /api/periods/[id]/arca-sync/decision — la persona resuelve la vista
// previa de UNA fuente descargada de ARCA:
//  - { source, action: "confirm", consumerFinalLegend? } incorpora las filas
//    aptas con el importador existente. Antes recalcula la vista previa: si ya
//    no coincide con la que se mostró, no escribe y responde 409 con la nueva.
//  - { source, action: "discard" } descarta la descarga sin incorporar nada.
// En ambos casos se borra el archivo guardado. Nada se incorpora sin este paso.
export const POST = withApiAuthz(async (request: Request, context: Context) => {
    const { id } = await context.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { period } = await requirePeriodAccess(profileId, id, ROLES_CREATE);
    const body = await parseJsonBody(request) as { source?: unknown; action?: unknown; consumerFinalLegend?: unknown } | null;
    const source = ARCA_SYNC_SOURCES.find((value) => value === body?.source);
    if (!source) throw new ValidationError("Fuente inválida.", "source");
    if (body?.action !== "confirm" && body?.action !== "discard") throw new ValidationError("Acción inválida.", "action");
    if (body.consumerFinalLegend !== undefined && typeof body.consumerFinalLegend !== "boolean") throw new ValidationError("consumerFinalLegend debe ser booleano.", "consumerFinalLegend");
    const consumerFinalLegend = body.consumerFinalLegend === true;
    if (consumerFinalLegend && source !== "SALES") throw new ValidationError("La leyenda «CONSUMIDOR FINAL» sólo se aplica a ventas.", "consumerFinalLegend");

    const latest = await prisma.arcaSyncTask.findFirst({ where: { periodId: id }, orderBy: { createdAt: "desc" }, select: { runKey: true } });
    const task = latest && await prisma.arcaSyncTask.findUnique({
        where: { periodId_runKey_source: { periodId: id, runKey: latest.runKey, source } },
        select: { id: true, status: true, preview: true },
    });
    if (!task || !task.preview) throw new ConflictError("Esa fuente no tiene una vista previa para resolver.");

    if (body.action === "discard") {
        const discarded = await prisma.arcaSyncTask.updateMany({ where: { id: task.id, status: "PREVIEW" }, data: { status: "DISCARDED" } });
        if (!discarded.count) throw new ConflictError("Esa fuente no tiene una vista previa para resolver.");
        await prisma.arcaSyncFile.deleteMany({ where: { taskId: task.id } });
        return NextResponse.json(await getSyncStatus(id, period.clientId));
    }

    if (period.status !== "OPEN") throw new ConflictError("El período está cerrado.");
    const claimed = await prisma.arcaSyncTask.updateMany({
        where: { id: task.id, OR: [{ status: "PREVIEW" }, { status: "CONFIRMING", updatedAt: { lt: new Date(Date.now() - CONFIRM_STALE_MS) } }] },
        data: { status: "CONFIRMING" },
    });
    if (!claimed.count) throw new ConflictError("Esa fuente no tiene una vista previa para resolver.");
    const release = (data: Prisma.ArcaSyncTaskUpdateManyMutationInput) => prisma.arcaSyncTask.updateMany({ where: { id: task.id, status: "CONFIRMING" }, data });
    try {
        const stored = await prisma.arcaSyncFile.findMany({ where: { taskId: task.id }, orderBy: { position: "asc" } });
        if (!stored.length) throw new ImportRejectedError("file-errors");
        const files = stored.map((file) => ({ content: new Uint8Array(file.content), format: file.format, sha256: file.sha256 }));
        const result = await confirmSyncPreview(
            { id: task.id, source: source as SyncSource, clientId: period.clientId }, files,
            task.preview as unknown as SyncPreviewSummary, { consumerFinalLegend }, importerInvoke(request.url, id),
        );
        const { counts } = result.variant;
        const pending = counts.REVIEW + counts.ERROR;
        await release({ status: pending ? "REVIEW" : "DONE", imported: result.imported, duplicates: counts.DUPLICATE, pending, preview: json(result.summary) });
        await prisma.arcaSyncFile.deleteMany({ where: { taskId: task.id } });
    } catch (error) {
        if (error instanceof PreviewChangedError) {
            const { counts } = error.summary;
            await release({ status: "PREVIEW", duplicates: counts.DUPLICATE, pending: counts.REVIEW + counts.ERROR, preview: json(error.summary) });
            throw new ConflictError("La vista previa cambió desde que la viste. Revisá la nueva antes de confirmar.");
        }
        // No se escribió o el importador ya registró su resultado: la vista previa sigue disponible.
        await release({ status: "PREVIEW" });
        if (error instanceof ImportRejectedError) throw new ConflictError("El importador ya no acepta el archivo descargado. Descartá la vista previa y volvé a importar.");
        if (error instanceof ConfirmFailedError) throw new ConflictError("No se pudo confirmar la incorporación. Volvé a intentar.");
        throw error;
    }
    return NextResponse.json(await getSyncStatus(id, period.clientId));
});
