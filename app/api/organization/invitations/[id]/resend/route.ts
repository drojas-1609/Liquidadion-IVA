import { NextResponse } from "next/server";
import { withApiAuthz } from "@/lib/auth/authz";
import { resendInvitation } from "@/lib/users/service";
import { acceptInviteRedirect, requireUsersManager } from "@/lib/users/route-authz";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/organization/invitations/[id]/resend — reenviar (sólo OWNER).
// Renueva el vencimiento; si estaba vencida vuelve a ocupar plaza (409 seats).
// Otra organización o inexistente: el mismo 404.
export const POST = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const actor = await requireUsersManager();
    const { id } = await ctx.params;
    const outcome = await resendInvitation(actor, id, acceptInviteRedirect(request));
    return NextResponse.json(outcome);
});
