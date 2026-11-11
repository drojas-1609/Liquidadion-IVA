import { createHash } from "node:crypto";
import { after, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { syncAuthorized } from "@/lib/arca-sync/auth";
import { enqueueScheduledSyncs, runNextSyncTask } from "@/lib/arca-sync/service";
import { withSyncIdentity } from "@/lib/arca-sync/identity";
import { requirePeriodAccess, withApiAuthz } from "@/lib/auth/authz";
import { ROLES_CREATE } from "@/lib/auth/roles";
import { POST as previewInvoices } from "@/app/api/periods/[id]/libro-iva-import/preview/route";
import { POST as confirmInvoices } from "@/app/api/periods/[id]/libro-iva-import/confirm/route";
import { POST as importTaxes } from "@/app/api/periods/[id]/tax-import/route";

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
        include: { period: { select: { clientId: true, year: true, month: true, client: { select: { cuit: true } } } } },
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
                source: task.source, periodId: task.periodId,
            });
        }
        if (body.action === "finish") {
            const permitted = ["EMPTY", "AUTH_REQUIRED", "FAILED"];
            if (!permitted.includes(body.status)) return response({ error: "INVALID_STATUS" }, 400);
            const allowedErrors = ["ARCA_SESSION", "ARCA_DOWNLOAD", "ARCA_FORMAT", "CREDENTIALS_MISSING", "VERIFICATION_REQUIRED", "REPRESENTATION_REQUIRED"];
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
        let downloaded = 0;
        let imported = 0;
        let duplicates = 0;
        const issues: Array<{ file: number; line: number; status: string; messages: string[] }> = [];
        await withSyncIdentity({
            profileId: task.actorProfileId, organizationId: task.organizationId, periodId: task.periodId,
        }, async () => {
            for (const [index, raw] of (body.files as FileInput[]).entries()) {
                if (!raw || typeof raw.file !== "string" || raw.file.length > 2_800_000) throw new Error("ARCA_FORMAT");
                const invoiceSource = task.source === "SALES" || task.source === "PURCHASES";
                const input = invoiceSource ? {
                    clientId: task.period.clientId, category: task.source, format: raw.format ?? "PORTAL_CSV",
                    vouchersFile: raw.file, acceptPartial: true,
                } : { kind: task.source, file: raw.file, confirm: false };
                const makeRequest = (value: unknown) => new Request(new URL("/api/arca-import", request.url), {
                    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
                });
                const context = { params: Promise.resolve({ id: task.periodId }) };
                const previewResponse = await (invoiceSource ? previewInvoices : importTaxes)(makeRequest(input), context);
                const preview = await previewResponse.json();
                if (!previewResponse.ok || preview.fileErrors?.length) throw new Error("ARCA_FORMAT");
                const counts = invoiceSource ? preview.reconciliation.statusCounts : preview.counts;
                const rows = preview.rows as Array<{ line: number; status: string; messages: string[] }>;
                downloaded += rows.length;
                duplicates += counts.DUPLICATE ?? 0;
                for (const row of rows.filter((r) => r.status !== "OK" && r.status !== "DUPLICATE")) {
                    issues.push({ file: index + 1, line: row.line, status: row.status, messages: row.messages });
                }
                if (!(counts.OK > 0)) continue;
                // Derivado del taskId y del archivo: estable al reintentar una respuesta perdida.
                const hex = createHash("sha256").update(task.id).update(String(index)).update(raw.file).digest("hex");
                const operationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
                const confirm = { ...input, token: preview.token, operationId, confirm: true };
                const result = await (invoiceSource ? confirmInvoices : importTaxes)(makeRequest(confirm), context);
                const data = await result.json();
                if (!result.ok) throw new Error("ARCA_IMPORT");
                imported += data.imported;
            }
        });
        await prisma.arcaSyncTask.updateMany({
            where: { id: task.id, status: "RUNNING", leaseUntil: lease },
            data: { status: issues.length ? "REVIEW" : "DONE", downloaded, imported, duplicates, pending: issues.length, issues, errorCode: null, leaseUntil: null },
        });
        advance();
        return response({ ok: true, downloaded, imported, duplicates, pending: issues.length });
    } catch (error) {
        await prisma.arcaSyncTask.updateMany({
            where: { id: task.id, status: "RUNNING", leaseUntil: lease },
            data: { status: "FAILED", errorCode: error instanceof Error && error.message === "ARCA_FORMAT" ? "ARCA_FORMAT" : "ARCA_IMPORT", leaseUntil: null },
        });
        advance();
        return response({ error: "IMPORT_FAILED" }, 422);
    }
});
