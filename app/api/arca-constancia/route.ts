import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireOrganizationRole, requireClientAccess, parseJsonBody, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_CLIENT_CREATE, ROLES_UPDATE } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { NotFoundError, ValidationError } from "@/lib/auth/errors";
import { pdfText } from "@/lib/arca-constancia/pdf-text";
import { ConstanciaParseError, parseConstancia } from "@/lib/arca-constancia/parse";
import { processPendingBackups, queueBackup } from "@/lib/drive/backup-service";

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_BYTES = 2 * 1024 * 1024;

// POST /api/arca-constancia { file (PDF en base64), clientId? }
// Lee la constancia de inscripción de ARCA (descargada por el usuario desde la
// consulta pública, que pide captcha) y devuelve sus datos para proponerlos en
// la ficha. Con clientId (cliente ya creado): verifica que el CUIT coincida y
// guarda el PDF en Drive (CONSTANCIAS), reemplazando el anterior.
export const POST = withApiAuthz(async (request: Request) => {
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const b = (await parseJsonBody(request)) as Record<string, unknown> | null;
    if (!b || typeof b !== "object") throw new ValidationError("Datos inválidos.", "body");
    const clientId = typeof b.clientId === "string" && b.clientId ? b.clientId : null;
    let client: { id: string; cuit: string } | null = null;
    if (clientId) {
        const access = await requireClientAccess(profileId, clientId, ROLES_UPDATE, { module: MODULES_CLIENT_DIRECTORY });
        if (access.organizationId !== organizationId) throw new NotFoundError();
        client = await prisma.client.findFirst({ where: { id: clientId, organizationId }, select: { id: true, cuit: true } });
        if (!client) throw new NotFoundError();
    } else {
        // Alta de cliente: sólo lectura del PDF (todavía no hay carpeta).
        await requireOrganizationRole(profileId, organizationId, ROLES_CLIENT_CREATE, { module: "CLIENTS" });
    }
    if (typeof b.file !== "string" || b.file.length === 0 || b.file.length % 4 !== 0 || !BASE64_RE.test(b.file)) throw new ValidationError("Elegí el PDF de la constancia.", "file");
    const bytes = Uint8Array.from(Buffer.from(b.file, "base64"));
    if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new ValidationError("El archivo supera 2 MB.", "file");
    if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") throw new ValidationError("El archivo no es un PDF.", "file");

    let constancia;
    try {
        constancia = parseConstancia(await pdfText(bytes));
    } catch (e) {
        throw new ValidationError(e instanceof ConstanciaParseError ? e.message : "No se pudo leer el PDF. Descargá la constancia de nuevo desde ARCA.", "file");
    }

    let backup: { queued: boolean; result: unknown } | null = null;
    if (client) {
        if (constancia.cuit.replace(/\D/g, "") !== client.cuit.replace(/\D/g, "")) {
            throw new ValidationError(`La constancia es del CUIT ${constancia.cuit}, no del cliente (${client.cuit}).`, "file");
        }
        const q = await queueBackup(prisma, {
            organizationId,
            clientId: client.id,
            periodId: null,
            category: "CONSTANCIAS",
            source: "arca-constancia",
            description: "CONSTANCIA DE INSCRIPCION",
            originalName: "constancia.pdf",
            bytes,
            profileId,
        });
        await recordAudit(prisma, {
            organizationId,
            actorProfileId: profileId,
            action: "client.arca_constancia",
            targetType: "Client",
            targetId: client.id,
            metadata: { issuedOn: constancia.issuedOn, verifier: constancia.verifier, queued: q.queued },
        });
        let result: unknown;
        try {
            result = await processPendingBackups(prisma, organizationId, { clientId: client.id, limit: 3, deadlineMs: 12000 });
        } catch (e) {
            result = { status: "error", message: e instanceof Error ? e.message.slice(0, 200) : "" };
        }
        backup = { queued: q.queued, result };
    }
    return NextResponse.json({ constancia, backup });
});
