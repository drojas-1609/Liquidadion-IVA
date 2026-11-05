import { NextResponse } from "next/server";
import { withApiAuthz } from "@/lib/auth/authz";
import { enableMember } from "@/lib/users/service";
import { requireUsersManager } from "@/lib/users/route-authz";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/organization/members/[id]/enable — reactivar un acceso (sólo
// OWNER). Vuelve a ocupar plaza (409 field "seats" si no hay).
export const POST = withApiAuthz(async (_request: Request, ctx: Ctx) => {
    const actor = await requireUsersManager();
    const { id } = await ctx.params;
    return NextResponse.json(await enableMember(actor, id));
});
