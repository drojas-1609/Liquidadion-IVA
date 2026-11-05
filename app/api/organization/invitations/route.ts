import { NextResponse } from "next/server";
import { parseJsonBody, withApiAuthz } from "@/lib/auth/authz";
import { ValidationError } from "@/lib/auth/errors";
import { parseInvite } from "@/lib/users/input";
import { inviteMember } from "@/lib/users/service";
import { acceptInviteRedirect, requireUsersManager } from "@/lib/users/route-authz";

// POST /api/organization/invitations — invitar por correo (sólo OWNER).
// Orden: authz (OWNER) -> parseo (400) -> validación (422) -> transacción con
// bloqueo del estudio: ya miembro / pendiente (409), clientes del estudio
// (422), cupo (409 field "seats") -> invitación + AuditLog -> envío del correo.
// 201 { invitationId, delivery } — delivery: SENT | FAILED | NOT_CONFIGURED |
// BLOCKED_RECIPIENT (la invitación queda pendiente y se puede reenviar).
export const POST = withApiAuthz(async (request: Request) => {
    const actor = await requireUsersManager();
    const parsed = parseInvite(await parseJsonBody(request));
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    const outcome = await inviteMember(actor, parsed.data, acceptInviteRedirect(request));
    return NextResponse.json(outcome, { status: 201 });
});
