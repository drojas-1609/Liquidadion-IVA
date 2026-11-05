import { NextResponse } from "next/server";
import { withApiAuthz } from "@/lib/auth/authz";
import { disableMember } from "@/lib/users/service";
import { requireUsersManager } from "@/lib/users/route-authz";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/organization/members/[id]/disable — desactivar un acceso (sólo
// OWNER). Libera la plaza. La siguiente solicitud de esa persona ya no tiene
// organización (403 NO_ORGANIZATION), aunque su sesión siga abierta.
export const POST = withApiAuthz(async (_request: Request, ctx: Ctx) => {
    const actor = await requireUsersManager();
    const { id } = await ctx.params;
    return NextResponse.json(await disableMember(actor, id));
});
