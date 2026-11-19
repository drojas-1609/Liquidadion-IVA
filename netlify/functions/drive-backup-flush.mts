import { syncOrigin } from "../../lib/arca-sync/auth";

// Cada 30 minutos sube a Google Drive los respaldos que quedaron pendientes.
export const config = { schedule: "*/30 * * * *" };

export default async function driveBackupFlush() {
    const origin = syncOrigin();
    const token = process.env.DRIVE_BACKUP_CRON_TOKEN;
    if (!origin || !token) return new Response(null, { status: 204 });
    const response = await fetch(new URL("/api/internal/drive-backup", origin), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(25000),
        redirect: "error",
    });
    if (!response.ok) throw new Error("DRIVE_BACKUP_FLUSH_FAILED");
    return new Response(null, { status: 204 });
}
