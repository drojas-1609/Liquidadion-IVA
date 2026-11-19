import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import prisma from "@/lib/prisma";
import { processPendingBackups } from "@/lib/drive/backup-service";
import { withApiAuthz } from "@/lib/auth/authz";

// POST /api/internal/drive-backup — llamada por la tarea programada
// (netlify/functions/drive-backup-flush): sube los respaldos pendientes de cada
// organización con Drive conectado. Autenticada con DRIVE_BACKUP_CRON_TOKEN.
// Sin sesión de usuario: la autoriza el token de la tarea programada.
export const POST = withApiAuthz(async (request: Request) => {
    const expected = process.env.DRIVE_BACKUP_CRON_TOKEN ?? "";
    const got = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    if (expected.length < 32 || got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
        return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    const conns = await prisma.driveConnection.findMany({ select: { organizationId: true } });
    const deadline = Date.now() + 20000;
    let uploaded = 0, failed = 0;
    for (const c of conns) {
        const left = deadline - Date.now();
        if (left < 2000) break;
        try {
            const r = await processPendingBackups(prisma, c.organizationId, { limit: 20, deadlineMs: left - 1000 });
            if (r.status === "ok") { uploaded += r.uploaded; failed += r.failed; }
        } catch (e) {
            console.error("[respaldo-drive] organización con error", e instanceof Error ? e.name : typeof e);
        }
    }
    return NextResponse.json({ uploaded, failed }, { headers: { "Cache-Control": "no-store" } });
});
