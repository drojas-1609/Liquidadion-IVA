import { NextResponse } from "next/server";
import { parseJsonBody, withApiAuthz } from "@/lib/auth/authz";
import { ValidationError } from "@/lib/auth/errors";
import { parsePermissions } from "@/lib/users/input";
import { updateMemberPermissions } from "@/lib/users/service";
import { requireUsersManager } from "@/lib/users/route-authz";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/organization/members/[id] — rol, alcance de clientes y módulos
// (sólo OWNER). El propietario y el propio acceso no se modifican (403). Rige
// en la solicitud siguiente de la persona, aunque conserve la sesión.
export const PATCH = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const actor = await requireUsersManager();
    const { id } = await ctx.params;
    const parsed = parsePermissions(await parseJsonBody(request));
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    const result = await updateMemberPermissions(actor, id, parsed.data);
    return NextResponse.json(result);
});
