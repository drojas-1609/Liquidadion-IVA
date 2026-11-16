import { storedInitialData } from "@/lib/arca-sync/initial-data";
import { after, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { syncAuthorized } from "@/lib/arca-sync/auth";
import { enqueueScheduledSyncs, runNextSyncTask } from "@/lib/arca-sync/service";
import { withSyncIdentity } from "@/lib/arca-sync/identity";
import { requirePeriodAccess, withApiAuthz } from "@/lib/auth/authz";
import { ROLES_CREATE } from "@/lib/auth/roles";
import type { Prisma } from "@prisma/client";
import { buildSyncPreview, fileSha256, ImportRejectedError, type SyncFile, type SyncSource } from "@/lib/arca-sync/preview-run";
import { importerInvoke } from "@/lib/arca-sync/importer-invoke";

export const maxDuration = 60;

function response(body: unknown, status = 200) {
    return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

type FileInput = { file: string; format?: "PORTAL_CSV" | "MIS_COMPROBANTES" };

export const POST = withApiAuthz(async (request: Request) => {
    if (!syncAuthorized(request.headers.get("authorization"))) return response({ error: "UNAUTHENTICATED" }, 401);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return response({ error: "INVALID_REQUEST" }, 400);
    if (body.action === "tick") {
        await enqueueScheduledSyncs(new Date());
        await runNextSyncTask();
        return response({ ok: true });
    }
    if (typeof body.taskId !== "string" || typeof body.lease !== "string") return response({ error: "INVALID_TASK" }, 400);
    const lease = new Date(body.lease);
    if (!Number.isFinite(lease.getTime())) return response({ error: "INVALID_LEASE" }, 400);
    const task = await prisma.arcaSyncTask.findFirst({
        where: { id: body.taskId, status: "RUNNING", leaseUntil: lease },
        include: { period: { select: { clientId: true, year: true, month: true, arcaSetting: { select: { initialData: true } }, client: { select: { cuit: true, condition: true, arcaInitialData: true } } } } },
    });
    if (!task || lease.getTime() <= Date.now()) return response({ error: "LEASE_EXPIRED" }, 409);
    const advance = () => after(async () => { await runNextSyncTask(task.periodId); });
    try {
        const access = await requirePeriodAccess(task.actorProfileId, task.periodId, ROLES_CREATE);
        if (access.organizationId !== task.organizationId || access.period.status !== "OPEN") {
            await prisma.arcaSyncTask.updateMany({
                where: { id: task.id, status: "RUNNING", leaseUntil: lease },
                data: { status: "FAILED", errorCode: "ACCESS_REVOKED", leaseUntil: null },
            });
            return response({ error: "ACCESS_REVOKED" }, 403);
        }
        if (body.action === "task") {
            const storedCredential = await prisma.arcaClientCredential.findUnique({
                where: { clientId_organizationId: { clientId: task.period.clientId, organizationId: task.organizationId } },
                select: { envelope: true, targetCuit: true },
            });
            return response({
                storedCredential, clientId: task.period.clientId, organizationId: task.organizationId,
                cuit: task.period.client.cuit.replace(/\D/g, ""), year: task.period.year, month: task.period.month,
                source: task.source, periodId: task.periodId, condition: task.period.client.condition,
                // Elección del período o, si no la hay, la predeterminada del cliente.
                initialData: storedInitialData(task.period.arcaSetting?.initialData) ?? storedInitialData(task.period.client.arcaInitialData),
            });
        }
        if (body.action === "finish") {
            const permitted = ["EMPTY", "AUTH_REQUIRED", "FAILED"];
            if (!permitted.includes(body.status)) return response({ error: "INVALID_STATUS" }, 400);
            const allowedErrors = ["ARCA_SESSION", "ARCA_DOWNLOAD", "ARCA_FORMAT", "ARCA_PAGE", "ARCA_PERIOD", "CREDENTIALS_MISSING", "VERIFICATION_REQUIRED", "REPRESENTATION_REQUIRED",
                "ARCA_DRAFT_OTHER_PERIOD", "ARCA_INITIAL_DATA_REQUIRED", "ARCA_TIMEOUT_LOGIN", "ARCA_TIMEOUT_SERVICE", "ARCA_TIMEOUT_REPRESENTATION", "ARCA_TIMEOUT_QUERY", "ARCA_TIMEOUT_EXPORT"];
            await prisma.arcaSyncTask.updateMany({
                where: { id: task.id, status: "RUNNING", leaseUntil: lease },
                data: {
                    status: body.status, errorCode: allowedErrors.includes(body.errorCode) ? body.errorCode : null,
                    ...(body.status === "EMPTY" ? { downloaded: 0, imported: 0, duplicates: 0 } : {}),
                    leaseUntil: null,
                },
            });
            advance();
            return response({ ok: true });
        }
        if (body.action !== "import" || !Array.isArray(body.files) || body.files.length < 1 || body.files.length > 4) {
            return response({ error: "INVALID_FILES" }, 400);
        }
        if (body.targetCuit !== task.period.client.cuit.replace(/\D/g, "")) {
            throw new Error("ARCA_IMPORT");
        }
        const files: SyncFile[] = [];
        for (const raw of body.files as FileInput[]) {
            if (!raw || typeof raw.file !== "string" || raw.file.length < 4 || raw.file.length > 2_800_000) throw new ImportRejectedError("file-errors");
            const content = Uint8Array.from(Buffer.from(raw.file, "base64"));
            files.push({ content, format: raw.format ?? null, sha256: fileSha256(content) });
        }
        // Sólo vista previa: la incorporación la confirma una persona desde el panel.
        const summary = await withSyncIdentity({
            profileId: task.actorProfileId, organizationId: task.organizationId, periodId: task.periodId,
        }, () => buildSyncPreview({ source: task.source as SyncSource, clientId: task.period.clientId }, files, importerInvoke(request.url, task.periodId)));
        const { counts } = summary;
        const downloaded = counts.OK + counts.DUPLICATE + counts.REVIEW + counts.ERROR;
        const pending = counts.REVIEW + counts.ERROR;
        await prisma.$transaction(async (tx) => {
            const claimed = await tx.arcaSyncTask.updateMany({
                where: { id: task.id, status: "RUNNING", leaseUntil: lease },
                data: { status: "PREVIEW", downloaded, imported: null, duplicates: counts.DUPLICATE, pending, preview: summary as unknown as Prisma.InputJsonValue, issues: [], errorCode: null, leaseUntil: null },
            });
            if (!claimed.count) throw new Error("LEASE_EXPIRED");
            await tx.arcaSyncFile.deleteMany({ where: { taskId: task.id } });
            await tx.arcaSyncFile.createMany({
                data: files.map((file, position) => ({ taskId: task.id, position, format: file.format, sha256: file.sha256, content: Buffer.from(file.content) })),
            });
        });
        console.warn(`[arca-sync] preview ready source=${task.source} files=${files.length} rows=${downloaded} ok=${counts.OK} duplicate=${counts.DUPLICATE} review=${counts.REVIEW} error=${counts.ERROR}`);
        advance();
        return response({ ok: true, preview: true, downloaded, duplicates: counts.DUPLICATE, pending });
    } catch (error) {
        const rejected = error instanceof ImportRejectedError;
        // Sólo el motivo genérico: los mensajes del lector pueden citar datos del archivo.
        if (rejected) console.warn(`[arca-sync] import rejected source=${task.source} reason=${error.reason}`);
        await prisma.arcaSyncTask.updateMany({
            where: { id: task.id, status: "RUNNING", leaseUntil: lease },
            data: { status: "FAILED", errorCode: rejected ? "IMPORT_REJECTED" : "ARCA_IMPORT", leaseUntil: null },
        });
        advance();
        return response({ error: "IMPORT_FAILED" }, 422);
    }
});
