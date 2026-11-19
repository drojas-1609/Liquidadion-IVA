import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireClientAccess, parseJsonBody, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { NotFoundError, ValidationError } from "@/lib/auth/errors";
import { BACKUP_CATEGORIES, type BackupCategory } from "@/lib/drive/naming";
import { MAX_BACKUP_BYTES, processPendingBackups, queueBackup } from "@/lib/drive/backup-service";

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const YEARLY: readonly BackupCategory[] = ["BANCOS", "CONTABILIDAD"];

// POST /api/clients/[id]/backups — sube al respaldo un comprobante que no entra
// por un importador (F.931, boletas, extractos, DDJJ, VEP…). El nombre y la
// carpeta los arma el sistema; el archivo original no se modifica.
export const POST = withApiAuthz(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const access = await requireClientAccess(profileId, id, ROLES_UPDATE, { module: MODULES_CLIENT_DIRECTORY });
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const b = (await parseJsonBody(request)) as Record<string, unknown> | null;
    if (!b || typeof b !== "object") throw new ValidationError("Datos inválidos.", "body");
    const category = b.category as BackupCategory;
    if (!BACKUP_CATEGORIES.includes(category)) throw new ValidationError("Elegí dónde va el comprobante.", "category");
    const description = typeof b.description === "string" ? b.description.trim() : "";
    if (description.length < 2 || description.length > 120) throw new ValidationError("Escribí una descripción corta (p. ej. «F931 VEP»).", "description");
    if (typeof b.file !== "string" || b.file.length === 0 || b.file.length % 4 !== 0 || !BASE64_RE.test(b.file)) throw new ValidationError("Elegí el archivo.", "file");
    const bytes = Uint8Array.from(Buffer.from(b.file, "base64"));
    if (bytes.length === 0 || bytes.length > MAX_BACKUP_BYTES) throw new ValidationError("El archivo supera 20 MB.", "file");
    const fileName = typeof b.fileName === "string" ? b.fileName.slice(0, 200) : null;
    let periodId: string | null = null;
    let year: number | undefined;
    if (YEARLY.includes(category)) {
        year = Number(b.year);
        if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new ValidationError("Año inválido.", "year");
    } else {
        if (typeof b.periodId !== "string") throw new ValidationError("Elegí el período.", "periodId");
        const p = await prisma.period.findFirst({ where: { id: b.periodId, organizationId, clientId: id }, select: { id: true } });
        if (!p) throw new ValidationError("Período inexistente.", "periodId");
        periodId = p.id;
    }
    const bank = category === "BANCOS" && typeof b.bank === "string" ? b.bank.trim().slice(0, 60) : null;
    if (category === "BANCOS" && !bank) throw new ValidationError("Indicá el banco o la cuenta.", "bank");

    const q = await queueBackup(prisma, { organizationId, clientId: id, periodId, year, bank, category, source: "manual", description, originalName: fileName, bytes, profileId });
    await recordAudit(prisma, { organizationId, actorProfileId: profileId, action: "drive.backup_upload", targetType: "Client", targetId: id, metadata: { category, queued: q.queued } });
    let result;
    try { result = await processPendingBackups(prisma, organizationId, { clientId: id, limit: 5, deadlineMs: 15000 }); }
    catch (e) { result = { status: "error", message: e instanceof Error ? e.message.slice(0, 200) : "" }; }
    return NextResponse.json({ queued: q.queued, duplicate: !q.queued, result }, { status: 201 });
});
