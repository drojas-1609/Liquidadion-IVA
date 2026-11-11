import { syncAuthorized, syncOrigin } from "../../lib/arca-sync/auth";
import { downloadArca, ArcaBrowserError, type ArcaDownloadTask } from "../../lib/arca-sync/browser";

export const config = { background: true };

export default async function arcaDownload(request: Request) {
    if (!syncAuthorized(request.headers.get("authorization"))) return new Response(null, { status: 401 });
    const origin = syncOrigin();
    if (!origin) throw new Error("ARCA_SYNC_CONFIGURATION");
    const input = await request.json() as { taskId?: unknown; lease?: unknown };
    if (typeof input.taskId !== "string" || typeof input.lease !== "string") return new Response(null, { status: 400 });
    const command = async (action: string, data: Record<string, unknown> = {}) => fetch(new URL("/api/internal/arca-sync", origin), {
        method: "POST", redirect: "error",
        headers: { Authorization: request.headers.get("authorization")!, "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, action, ...data }), signal: AbortSignal.timeout(55000),
    });
    const details = await command("task");
    if (!details.ok) return new Response(null, { status: 204 });
    const task = await details.json() as ArcaDownloadTask;
    try {
        const result = await downloadArca(task);
        const saved = await command(result.empty ? "finish" : "import", result.empty ? { status: "EMPTY" } : { files: result.files });
        if (!saved.ok) throw new Error("ARCA_IMPORT_FAILED");
    } catch (error) {
        const code = error instanceof ArcaBrowserError ? error.code : "ARCA_DOWNLOAD";
        await command("finish", { status: code === "ARCA_SESSION" || code === "VERIFICATION_REQUIRED" ? "AUTH_REQUIRED" : "FAILED", errorCode: code });
    }
    return new Response(null, { status: 204 });
}
