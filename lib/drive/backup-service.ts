import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
    backupFileName, backupFolderPath, guessExtension, mimeFor, withSuffix,
    type BackupCategory,
} from "./naming";
import { DriveError, createFolder, driveOAuthConfig, findFile, findFolder, refreshAccessToken, uploadFile } from "./google";

type Db = Pick<PrismaClient, "documentBackup" | "driveConnection" | "driveFolder" | "client" | "period">;

export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
export const MAX_ATTEMPTS = 5;

// --- Cifrado del refresh token (AES-256-GCM; AAD = organización) -------------

export function driveTokenKey(): Buffer | null {
    const v = process.env.DRIVE_TOKEN_KEY;
    return v && /^[a-f0-9]{64}$/i.test(v) ? Buffer.from(v, "hex") : null;
}

export function sealToken(token: string, organizationId: string, key: Buffer): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from(organizationId));
    const enc = Buffer.concat([c.update(token, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64url");
}

export function openToken(sealed: string, organizationId: string, key: Buffer): string {
    const b = Buffer.from(sealed, "base64url");
    const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    d.setAAD(Buffer.from(organizationId));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

// --- Cola de respaldos ---------------------------------------------------------

export interface BackupInput {
    organizationId: string;
    clientId: string;
    periodId: string | null;
    /** Año para categorías sin período (BANCOS, CONTABILIDAD) si no hay periodId. */
    year?: number;
    bank?: string | null;
    category: BackupCategory;
    /** Origen dentro del sistema, p. ej. «libro-iva-import». */
    source: string;
    description: string;
    originalName?: string | null;
    bytes: Uint8Array;
    profileId: string | null;
}

/** Registra el archivo para respaldar. Si ya se respaldó el mismo contenido, no hace nada. */
export async function queueBackup(db: Db, input: BackupInput): Promise<{ queued: boolean }> {
    if (input.bytes.length === 0 || input.bytes.length > MAX_BACKUP_BYTES) return { queued: false };
    const client = await db.client.findFirst({ where: { id: input.clientId, organizationId: input.organizationId }, select: { name: true, cuit: true } });
    if (!client) return { queued: false };
    let month: number | null = null;
    let year = input.year ?? new Date().getUTCFullYear();
    if (input.periodId) {
        const p = await db.period.findFirst({ where: { id: input.periodId, organizationId: input.organizationId }, select: { month: true, year: true } });
        if (!p) return { queued: false };
        month = p.month; year = p.year;
    }
    const extension = guessExtension(input.originalName, input.bytes);
    const target = { category: input.category, client: { name: client.name, cuit: client.cuit }, month, year, bank: input.bank ?? null, description: input.description, extension };
    const folderPath = backupFolderPath(target).join("/");
    const fileName = backupFileName(target);
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const r = await db.documentBackup.createMany({
        data: [{
            organizationId: input.organizationId, clientId: input.clientId, periodId: input.periodId,
            category: input.category, source: input.source, description: input.description.slice(0, 200),
            folderPath, fileName, mimeType: mimeFor(extension), size: input.bytes.length, sha256,
            content: Buffer.from(input.bytes), createdById: input.profileId,
        }],
        skipDuplicates: true,
    });
    return { queued: r.count > 0 };
}

// --- Subida a Drive --------------------------------------------------------------

export type ProcessResult =
    | { status: "not_configured" | "not_connected" }
    | { status: "ok"; uploaded: number; failed: number; remaining: number };

async function ensureFolder(db: Db, token: string, organizationId: string, rootId: string, segments: string[]): Promise<string> {
    let parent = rootId;
    for (let i = 0; i < segments.length; i++) {
        const path = segments.slice(0, i + 1).join("/");
        const cached = await db.driveFolder.findUnique({ where: { organizationId_path: { organizationId, path } }, select: { folderId: true } });
        if (cached) { parent = cached.folderId; continue; }
        const id = (await findFolder(token, parent, segments[i])) ?? (await createFolder(token, parent, segments[i]));
        await db.driveFolder.upsert({ where: { organizationId_path: { organizationId, path } }, create: { organizationId, path, folderId: id }, update: { folderId: id } });
        parent = id;
    }
    return parent;
}

/**
 * Sube a Drive los respaldos pendientes (de un cliente o de toda la
 * organización). Cada archivo se «reserva» incrementando `attempts` para que
 * dos procesos no lo suban a la vez. Un nombre ya usado con el mismo contenido
 * (md5) se toma como subido; con otro contenido se agrega « (2)», « (3)»…
 */
export async function processPendingBackups(db: Db, organizationId: string, opts: { clientId?: string; limit?: number; deadlineMs?: number } = {}): Promise<ProcessResult> {
    const cfg = driveOAuthConfig();
    const key = driveTokenKey();
    if (!cfg || !key) return { status: "not_configured" };
    const conn = await db.driveConnection.findUnique({ where: { organizationId } });
    if (!conn) return { status: "not_connected" };
    const deadline = Date.now() + (opts.deadlineMs ?? 8000);
    const token = await refreshAccessToken(cfg, openToken(conn.refreshTokenSealed, organizationId, key));
    const where = { organizationId, ...(opts.clientId ? { clientId: opts.clientId } : {}), status: { in: ["PENDING", "ERROR"] }, attempts: { lt: MAX_ATTEMPTS } };
    const items = await db.documentBackup.findMany({ where, orderBy: { createdAt: "asc" }, take: opts.limit ?? 10, select: { id: true, attempts: true, folderPath: true, fileName: true, mimeType: true, content: true } });
    let uploaded = 0, failed = 0;
    for (const it of items) {
        if (Date.now() > deadline) break;
        const claim = await db.documentBackup.updateMany({ where: { id: it.id, attempts: it.attempts, status: { in: ["PENDING", "ERROR"] } }, data: { attempts: it.attempts + 1 } });
        if (claim.count === 0 || !it.content) continue;
        try {
            const bytes = new Uint8Array(it.content);
            const md5 = createHash("md5").update(bytes).digest("hex");
            const folderId = await ensureFolder(db, token, organizationId, conn.rootFolderId, it.folderPath.split("/"));
            let name = it.fileName;
            let done: { id: string; webViewLink?: string } | null = null;
            for (let n = 2; n < 50 && !done; n++) {
                const existing = await findFile(token, folderId, name);
                if (!existing) done = await uploadFile(token, folderId, name, it.mimeType, bytes);
                else if (existing.md5Checksum === md5) done = existing;
                else name = withSuffix(it.fileName, n);
            }
            if (!done) throw new DriveError("Demasiados archivos con el mismo nombre.", 409);
            await db.documentBackup.update({ where: { id: it.id }, data: { status: "DONE", content: null, fileName: name, driveFileId: done.id, driveLink: done.webViewLink ?? null, uploadedAt: new Date(), lastError: null } });
            uploaded++;
        } catch (e) {
            failed++;
            const msg = (e instanceof Error ? e.message : "Error desconocido").slice(0, 300);
            await db.documentBackup.update({ where: { id: it.id }, data: { status: "ERROR", lastError: msg } });
        }
    }
    const remaining = await db.documentBackup.count({ where: { organizationId, ...(opts.clientId ? { clientId: opts.clientId } : {}), status: { in: ["PENDING", "ERROR"] } } });
    return { status: "ok", uploaded, failed, remaining };
}

/**
 * Respaldo después de una importación confirmada: nunca hace fallar la
 * importación (ya grabada). Registra el archivo y trata de subir enseguida los
 * pendientes del cliente; lo que no se suba queda para «Reintentar» o para la
 * tarea programada.
 */
export async function backupAfterImport(db: Db, input: BackupInput): Promise<void> {
    try {
        await queueBackup(db, input);
        await processPendingBackups(db, input.organizationId, { clientId: input.clientId, limit: 5, deadlineMs: 6000 });
    } catch (e) {
        console.error("[respaldo-drive] no se pudo respaldar", input.source, e instanceof Error ? e.message : e);
    }
}
