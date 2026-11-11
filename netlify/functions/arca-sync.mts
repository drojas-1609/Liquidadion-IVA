import { syncOrigin } from "../../lib/arca-sync/auth";

export const config = { schedule: "*/5 * * * *" };

export default async function arcaSync() {
    const origin = syncOrigin();
    const token = process.env.ARCA_SYNC_CONNECTOR_TOKEN;
    if (!origin || !token) return new Response(null, { status: 204 });
    const response = await fetch(new URL("/api/internal/arca-sync", origin), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "tick" }),
        signal: AbortSignal.timeout(25000),
        redirect: "error",
    });
    if (!response.ok) throw new Error("ARCA_SYNC_TICK_FAILED");
    return new Response(null, { status: 204 });
}
