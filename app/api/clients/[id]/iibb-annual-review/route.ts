import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireClientAccess, parseJsonBody, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_CLIENT_MANAGE } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/auth/errors";
import { lockClientForUpdate, nextClientVersion } from "@/lib/client-lock";
import { canApplyRule, canKeep, parseAnnualReviewBody } from "@/lib/iibb/annual-review";
import { loadAnnualReview } from "@/lib/iibb/annual-review-store";
import { parseRate } from "@/lib/validation/decimal";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/clients/[id]/iibb-annual-review — revisión anual del año en curso:
// - APPLY_RULE: aplica la sugerencia ÚNICA del conjunto aprobado (ficha + año);
// - KEEP: registra para el año el valor actual de la ficha.
// Ambas guardan quién y cuándo. Si algo cambió desde que se abrió la pantalla,
// rechaza con 409 sin escribir nada.
export const POST = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const access = await requireClientAccess(profileId, id, ROLES_CLIENT_MANAGE, { module: MODULES_CLIENT_DIRECTORY });
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const parsed = parseAnnualReviewBody(await parseJsonBody(request));
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);

    const result = await prisma.$transaction(
        async (tx) => {
            const locked = await lockClientForUpdate(tx, id, organizationId);
            if (!locked) throw new NotFoundError();
            const review = await loadAnnualReview(tx, { organizationId, clientId: id });
            if (!review) throw new NotFoundError();
            const byId = new Map(review.rows.map((r) => [r.rateId, r]));
            for (const it of parsed.items) {
                const row = byId.get(it.rateId);
                if (!row) throw new NotFoundError();
                const ok = it.action === "APPLY_RULE" ? canApplyRule(row) && row.suggestion?.ruleRef === it.ruleRef : canKeep(row);
                if (!ok) throw new ConflictError("Alguna alícuota cambió o ya está confirmada para el año. Recargá la página y revisá de nuevo.");
            }
            let profileChanged = false;
            for (const it of parsed.items) {
                const row = byId.get(it.rateId)!;
                let data: { rate: Prisma.Decimal | null; treatment: "RATE" | "EXEMPT"; rateOrigin: "STUDIO_MANUAL" | "CONFIRMED_SUGGESTION" | null; ruleRef: string | null; minimumAmount: Prisma.Decimal | null };
                if (it.action === "APPLY_RULE") {
                    const alt = row.suggestion!;
                    let rate: Prisma.Decimal | null = null;
                    if (alt.treatment === "RATE") {
                        const p = parseRate(alt.rate);
                        if (!p.ok) throw new Error("tasa de regla inválida");
                        rate = p.value;
                    }
                    const minimumAmount = alt.treatment === "RATE" && alt.minimumMonthly ? new Prisma.Decimal(alt.minimumMonthly) : null;
                    data = { rate, treatment: alt.treatment, rateOrigin: "CONFIRMED_SUGGESTION", ruleRef: alt.ruleRef, minimumAmount };
                    const upd = await tx.clientActivityRate.updateMany({ where: { id: row.rateId, clientId: id, organizationId }, data });
                    if (upd.count !== 1) throw new NotFoundError();
                    profileChanged = true;
                } else {
                    // Mantener: el año toma exactamente lo que dice la ficha (misma forma que la sincronización al guardarla).
                    data = {
                        rate: row.treatment === "RATE" && row.rate !== null ? new Prisma.Decimal(row.rate) : null,
                        treatment: row.treatment,
                        rateOrigin: row.origin,
                        ruleRef: row.ruleRef,
                        minimumAmount: row.minimum !== null ? new Prisma.Decimal(row.minimum) : null,
                    };
                }
                await tx.clientIibbRateYear.deleteMany({ where: { clientId: id, organizationId, fiscalYear: review.year, jurisdictionCode: row.jurisdictionCode, activityCode: row.activityCode } });
                await tx.clientIibbRateYear.create({
                    data: { ...data, organizationId, clientId: id, fiscalYear: review.year, jurisdictionCode: row.jurisdictionCode, activityCode: row.activityCode, confirmedById: profileId },
                });
            }
            // Si la ficha cambió, avanza la versión para que un formulario abierto detecte el conflicto.
            if (profileChanged) await tx.client.update({ where: { id_organizationId: { id, organizationId } }, data: { updatedById: profileId, updatedAt: nextClientVersion(locked.updatedAt, Date.now()) } });
            await recordAudit(tx, { organizationId, actorProfileId: profileId, action: "client.iibb_annual_review", targetType: "Client", targetId: id, metadata: { fiscalYear: review.year, count: parsed.items.length } });
            return { fiscalYear: review.year, count: parsed.items.length };
        },
    );
    return NextResponse.json({ ok: true, ...result });
});
