import "server-only";
import { qEscape } from "./naming";

/**
 * Cliente mínimo de la API de Google Drive v3 (fetch, sin dependencias).
 * Credenciales: GOOGLE_DRIVE_CLIENT_ID y GOOGLE_DRIVE_CLIENT_SECRET (cliente
 * OAuth «Aplicación web» de Google Cloud, cargado en Netlify por el estudio).
 * El refresh token de la cuenta conectada se guarda cifrado en la base.
 */

export const DRIVE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/drive"];
const FOLDER_MIME = "application/vnd.google-apps.folder";

export class DriveError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
}

export function driveOAuthConfig() {
    // trim: un espacio o salto de línea pegado con el valor hace que Google
    // responda «invalid_client / The OAuth client was not found».
    const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID?.trim();
    const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET?.trim();
    return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function authUrl(clientId: string, redirectUri: string, state: string): string {
    const p = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: DRIVE_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(body: Record<string, string>) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
        cache: "no-store",
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !json || typeof json.access_token !== "string") {
        throw new DriveError(`Google rechazó la credencial (${typeof json?.error === "string" ? json.error : res.status}).`, res.status);
    }
    return json as { access_token: string; refresh_token?: string; id_token?: string };
}

export async function exchangeCode(cfg: { clientId: string; clientSecret: string }, code: string, redirectUri: string) {
    return tokenRequest({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" });
}

export async function refreshAccessToken(cfg: { clientId: string; clientSecret: string }, refreshToken: string): Promise<string> {
    const t = await tokenRequest({ refresh_token: refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: "refresh_token" });
    return t.access_token;
}

async function api<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) }, cache: "no-store" });
    if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new DriveError(`Drive: ${j?.error?.message ?? res.statusText} (${res.status}).`, res.status);
    }
    return (await res.json()) as T;
}

export async function accountEmail(token: string): Promise<string | null> {
    const j = await api<{ email?: string }>(token, "https://openidconnect.googleapis.com/v1/userinfo");
    return j.email ?? null;
}


type DriveFile = { id: string; name: string; md5Checksum?: string; webViewLink?: string };

async function findByName(token: string, parentId: string, name: string, folder: boolean): Promise<DriveFile[]> {
    const q = `name = '${qEscape(name)}' and '${qEscape(parentId)}' in parents and trashed = false and mimeType ${folder ? "=" : "!="} '${FOLDER_MIME}'`;
    const p = new URLSearchParams({ q, fields: "files(id,name,md5Checksum,webViewLink)", pageSize: "10", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    const j = await api<{ files: DriveFile[] }>(token, `https://www.googleapis.com/drive/v3/files?${p}`);
    return j.files ?? [];
}

export async function findFolder(token: string, parentId: string, name: string): Promise<string | null> {
    return (await findByName(token, parentId, name, true))[0]?.id ?? null;
}

export async function createFolder(token: string, parentId: string, name: string): Promise<string> {
    const j = await api<{ id: string }>(token, "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    return j.id;
}

export async function findFile(token: string, parentId: string, name: string): Promise<DriveFile | null> {
    return (await findByName(token, parentId, name, false))[0] ?? null;
}

export async function uploadFile(token: string, parentId: string, name: string, mime: string, bytes: Uint8Array): Promise<DriveFile> {
    const boundary = `dero${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const meta = JSON.stringify({ name, parents: [parentId], mimeType: mime });
    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`, "utf8"),
        Buffer.from(bytes),
        Buffer.from(`\r\n--${boundary}--`, "utf8"),
    ]);
    return api<DriveFile>(token, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,md5Checksum,webViewLink", {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
    });
}
