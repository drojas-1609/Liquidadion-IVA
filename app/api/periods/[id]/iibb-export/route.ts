import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import prisma from "@/lib/prisma";
import { buildF5680, F5680_TYPES, type F5680Kind } from "@/lib/iibb-export/f5680";
import { localIibbJurisdiction } from "@/lib/liquidation-totals";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    requirePeriodAccess,
    withApiAuthz,
} from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_EXPORT } from "@/lib/auth/roles";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/auth/errors";

type Ctx = { params: Promise<{ id: string }> };

const KINDS: readonly F5680Kind[] = ["percepciones", "retenciones", "bancarias"];
/** Santa Cruz (código de la Comisión Arbitral): el único diseño de importación verificado. */
const SANTA_CRUZ = "920";

// GET /api/periods/[id]/iibb-export?kind=percepciones|retenciones|bancarias —
// TXT de importación del F.5680 (Santa Cruz, Mis Aplicaciones Web) con las
// deducciones registradas del período (lib/iibb-export/f5680). Sólo lectura.
// Si un registro no se puede armar sin suponer datos: 409 con el motivo, sin
// archivo. AuditLog iibb.f5680.export (tipo, cantidad y huella; sin importes ni CUIT).
export const GET = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const kind = new URL(request.url).searchParams.get("kind") as F5680Kind | null;
    if (!kind || !KINDS.includes(kind)) throw new ValidationError("kind debe ser percepciones, retenciones o bancarias", "kind");

    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_EXPORT);
    const access = await requirePeriodAccess(profileId, id, ROLES_EXPORT);
    if (access.organizationId !== organizationId) throw new NotFoundError();

    const period = await prisma.period.findFirst({
        where: { id, organizationId },
        select: {
            month: true, year: true, clientId: true,
            client: { select: { cuit: true, iibbRegistration: true, jurisdictions: { select: { jurisdictionCode: true } } } },
        },
    });
    if (!period) throw new NotFoundError();
    if (localIibbJurisdiction(period.client) !== SANTA_CRUZ) {
        throw new ConflictError("El F.5680 es la DDJJ local de Santa Cruz: el cliente debe estar inscripto como local sólo en Santa Cruz.");
    }
    const records = await prisma.taxRecord.findMany({
        where: { periodId: id, organizationId, type: { in: [...F5680_TYPES[kind]] }, OR: [{ jurisdictionCode: SANTA_CRUZ }, { jurisdictionCode: null }] },
        select: {
            id: true, type: true, date: true, amount: true, agentCuit: true, voucherNumber: true, pointOfSale: true,
            voucherKind: true, voucherLetter: true, certificateNumber: true, cbu: true,
            invoice: { select: { voucherCode: true, pointOfSale: true, number: true } },
        },
    });
    const out = buildF5680(kind, records);
    if (out.problems.length > 0) {
        const first = out.problems.slice(0, 3).map((p) => p.reason).join("; ");
        throw new ConflictError(`${out.problems.length} registro(s) no se pueden exportar: ${first}.`);
    }
    if (out.lines.length === 0) throw new ConflictError(`No hay ${kind} de IIBB de Santa Cruz registradas en el período.`);
    const body = out.lines.join("\r\n") + "\r\n";
    const bytes = new TextEncoder().encode(body);
    const sha = createHash("sha256").update(bytes).digest("hex");
    await recordAudit(prisma, {
        organizationId,
        actorProfileId: profileId,
        action: "iibb.f5680.export",
        targetType: "Period",
        targetId: id,
        metadata: { periodId: id, kind, count: out.lines.length, fileSha256: sha },
    });
    const cuit = period.client.cuit.replace(/\D/g, "");
    const fileName = `F5680_${kind}_${cuit}_${period.year}${String(period.month).padStart(2, "0")}.txt`;
    return new NextResponse(bytes, {
        status: 200,
        headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": `attachment; filename="${fileName}"`,
            "Cache-Control": "no-store, max-age=0",
            "X-Content-Type-Options": "nosniff",
        },
    });
});
