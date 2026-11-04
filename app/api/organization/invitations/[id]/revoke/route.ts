import { NextResponse } from "next/server";
import { withApiAuthz } from "@/lib/auth/authz";
import { revokeInvitation } from "@/lib/users/service";
import { requireUsersManager } from "@/lib/users/route-authz";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/organization/invitations/[id]/revoke — revocar (sólo OWNER). Libera la plaza.
export const POST = withApiAuthz(async (_request: Request, ctx: Ctx) => {
    const actor = await requireUsersManager();
    const { id } = await ctx.params;
    await revokeInvitation(actor, id);
    return new NextResponse(null, { status: 204 });
});
