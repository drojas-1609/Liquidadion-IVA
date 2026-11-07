import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import prisma from "@/lib/prisma";
import { MissingGlobalProrationCoefficientError } from "@/lib/invoice-model";
import { computeLiquidation } from "@/lib/liquidation-calc";
import { contentHashFor, loadPeriodExportData } from "@/lib/vat-export/load";
import { packageFor } from "@/lib/vat-export/service";
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

// GET /api/periods/[id]/vat-package?mode=draft|final — paquete de presentación de IVA (ZIP).
//
// Lectura (todos los roles con módulo IVA y el cliente en el alcance; 404 si
// el período es de otra organización o no existe):
//  - final: período CERRADO con versión vigente CON paquete. Devuelve los
//    bytes GUARDADOS en el cierre (no los regenera) después de verificar su
//    sha256 y que la huella del contenido actual del período coincida con la
//    del cierre (si no: 409, no entrega). Sin paquete (cerró con bloqueos): 409.
//  - draft: período ABIERTO. Genera un BORRADOR identificado como tal en el
//    nombre del ZIP y de sus textos, con los mismos exportadores y el mismo
//    motor; lo pendiente queda omitido y explicado.
// En ambos casos el AuditLog vat.package.export se registra ANTES de entregar.
export const GET = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const mode = new URL(request.url).searchParams.get("mode");
    if (mode !== "draft" && mode !== "final") throw new ValidationError("mode debe ser draft o final", "mode");

    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_EXPORT);
    const access = await requirePeriodAccess(profileId, id, ROLES_EXPORT);
    if (access.organizationId !== organizationId) throw new NotFoundError();

    const data = await loadPeriodExportData(prisma, { organizationId, periodId: id });
    if (!data) throw new NotFoundError();

    let zip: Uint8Array;
    let fileName: string;
    let version: number | null = null;
    if (mode === "final") {
        if (data.period.status !== "CLOSED") throw new ConflictError("El período está abierto: la versión final se genera al cerrarlo. Descargá el borrador.");
        const current = await prisma.periodLiquidationVersion.findFirst({
            where: { periodId: id, organizationId, supersededAt: null },
            select: { version: true, contentHash: true, packageZip: true, packageSha256: true, summary: true },
        });
        if (!current) throw new ConflictError("El período se cerró antes de que existieran las versiones de liquidación: reabrilo y volvé a cerrarlo para generar el paquete.");
        if (!current.packageZip || !current.packageSha256) throw new ConflictError("La versión cerrada no tiene paquete: al cerrar había bloqueos de exportación. Reabrí el período, resolvelos y volvé a cerrar.");
        const bytes = new Uint8Array(current.packageZip);
        if (createHash("sha256").update(bytes).digest("hex") !== current.packageSha256) throw new Error("vat-package: el paquete guardado no coincide con su huella");
        const scheme = (current.summary as { hashScheme?: unknown } | null)?.hashScheme;
        const recomputed = contentHashFor(scheme, data);
        if (recomputed === null) throw new Error("vat-package: esquema de huella desconocido");
        if (recomputed !== current.contentHash) throw new ConflictError("El contenido del período no coincide con el de la versión cerrada: no se entrega el paquete. Avisá al administrador.");
        zip = bytes;
        version = current.version;
        const identity = (current.summary as { identity?: { clientCuit?: string } } | null)?.identity;
        const cuit = (identity?.clientCuit ?? data.client.cuit).replace(/\D/g, "");
        fileName = `IVA_${cuit}_${data.period.year}${String(data.period.month).padStart(2, "0")}_v${version}.zip`;
    } else {
        if (data.period.status !== "OPEN") throw new ConflictError("El período está cerrado: descargá la versión final.");
        let liquidation;
        try {
            liquidation = computeLiquidation(data.calc);
        } catch (err) {
            if (err instanceof MissingGlobalProrationCoefficientError) throw new ConflictError(err.message);
            throw err;
        }
        const pkg = packageFor(data, liquidation, "DRAFT", null, new Date());
        zip = pkg.zip;
        fileName = pkg.fileName;
    }
    const sha = createHash("sha256").update(zip).digest("hex");

    await recordAudit(prisma, {
        organizationId,
        actorProfileId: profileId,
        action: "vat.package.export",
        targetType: "Period",
        targetId: id,
        metadata: { periodId: id, clientId: data.period.clientId, month: data.period.month, year: data.period.year, mode: mode.toUpperCase(), version, packageSha256: sha },
    });

    return new NextResponse(new Uint8Array(zip), {
        status: 200,
        headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="${fileName}"`,
            "Cache-Control": "no-store, max-age=0",
            "X-Content-Type-Options": "nosniff",
        },
    });
});
