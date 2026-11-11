import { timingSafeEqual } from "node:crypto";

export const ARCA_WORKER_PATH = "/_arca-sync/worker";

export function syncAuthorized(authorization: string | null) {
    const secret = process.env.ARCA_SYNC_CONNECTOR_TOKEN;
    if (!secret || secret.length < 32 || !authorization?.startsWith("Bearer ")) return false;
    const received = Buffer.from(authorization.slice(7));
    const expected = Buffer.from(secret);
    return received.length === expected.length && timingSafeEqual(received, expected);
}

export function syncOrigin() {
    const raw = process.env.ARCA_SYNC_APP_ORIGIN;
    if (!raw) return null;
    try {
        const url = new URL(raw);
        return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/"
            && !url.search && !url.hash ? url.origin : null;
    } catch {
        return null;
    }
}

export function syncCredentials(cuit: string): { cuit: string; password: string } | null {
    try {
        const config = JSON.parse(process.env.ARCA_SYNC_CREDENTIALS ?? "{}") as Record<string, unknown>;
        const entry = config[cuit] as { cuit?: unknown; password?: unknown } | undefined;
        if (!/^\d{11}$/.test(cuit) || entry?.cuit !== cuit || typeof entry.password !== "string" || !entry.password) return null;
        return { cuit, password: entry.password };
    } catch {
        return null;
    }
}
