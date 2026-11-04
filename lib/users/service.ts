import "server-only";
import type { AppModule, ClientScope, Prisma, Role } from "@prisma/client";
import prisma from "@/lib/prisma";
import { recordAudit } from "@/lib/auth/audit";
import { AuthError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/auth/errors";
import { APP_MODULES } from "@/lib/auth/permissions";
import type { InviteInput, PermissionsInput } from "@/lib/users/input";
import { normalizeEmail } from "@/lib/users/input";
import { countSeats, INVITATION_TTL_MS, lockOrganization } from "@/lib/users/seats";
import type { UsersOverview } from "@/lib/users/views";
import { sendInvitationEmail, type DeliveryStatus } from "@/lib/users/invitation-mailer";

/**
 * Configuración → Usuarios: operaciones del propietario y aceptación de la
 * invitación. La AUTORIZACIÓN (OWNER de la organización activa) la hace la ruta
 * antes de llamar; acá viven las reglas de negocio:
 *
 *  - Toda operación corre en una transacción que primero bloquea la fila del
 *    estudio (lockOrganization): serializa invitaciones simultáneas, cambios de
 *    permisos y aceptaciones del mismo estudio.
 *  - Protección del propietario: una Membership OWNER no se modifica, no se
 *    desactiva y no se crea por invitación; nadie actúa sobre su propio acceso.
 *    Además, un trigger en la base impide dejar al estudio sin OWNER activo.
 *  - Auditoría mínima en la misma transacción (lib/auth/audit.ts).
 *  - El correo se envía DESPUÉS de confirmar la transacción: si falla, la
 *    invitación queda pendiente "sin enviar" y se puede reenviar o revocar.
 */

export interface UsersActor {
  profileId: string;
  organizationId: string;
}

export const SEATS_FULL_MESSAGE =
  "El estudio no tiene plazas disponibles. Revocá una invitación pendiente o desactivá un acceso para liberar una.";
const OWNER_PROTECTED_MESSAGE = "El acceso del propietario no se puede modificar ni desactivar.";
const SELF_MESSAGE = "No podés modificar tu propio acceso.";
const RESEND_COOLDOWN_MS = 60_000;

function seatsFull(): AuthError {
  return new AuthError("CONFLICT", 409, SEATS_FULL_MESSAGE, "seats");
}

type Tx = Prisma.TransactionClient;

/** Ids del estudio, en el orden recibido; 422 si alguno no es del estudio. */
async function requireOrgClients(tx: Tx, organizationId: string, clientIds: string[]): Promise<string[]> {
  if (clientIds.length === 0) return [];
  const found = await tx.client.findMany({ where: { organizationId, id: { in: clientIds } }, select: { id: true } });
  if (found.length !== clientIds.length) {
    throw new ValidationError("Hay clientes seleccionados que no pertenecen al estudio.", "clientIds");
  }
  return clientIds;
}

async function replaceClientAccess(tx: Tx, membershipId: string, organizationId: string, scope: ClientScope, clientIds: string[]) {
  await tx.membershipClient.deleteMany({ where: { membershipId } });
  if (scope === "SELECTED" && clientIds.length > 0) {
    await tx.membershipClient.createMany({
      data: clientIds.map((clientId) => ({ membershipId, clientId, organizationId })),
    });
  }
}

const modulesText = (m: readonly AppModule[]) => APP_MODULES.filter((x) => m.includes(x)).join(",");

// ── Invitar ───────────────────────────────────────────────────────────────

export interface InviteOutcome {
  invitationId: string;
  delivery: DeliveryStatus;
}

export async function inviteMember(actor: UsersActor, input: InviteInput, redirectTo: string): Promise<InviteOutcome> {
  const now = new Date();
  const invitation = await prisma.$transaction(async (tx) => {
    const org = await lockOrganization(tx, actor.organizationId);
    if (!org) throw new NotFoundError();

    const member = await tx.membership.findFirst({
      where: { organizationId: actor.organizationId, profile: { email: { equals: input.email, mode: "insensitive" } } },
      select: { status: true },
    });
    if (member?.status === "ACTIVE") throw new ConflictError("Esa persona ya tiene acceso al estudio.");
    if (member) throw new ConflictError("Esa persona tiene un acceso desactivado: reactivalo desde la lista de usuarios.");

    const pending = await tx.organizationInvitation.findFirst({
      where: { organizationId: actor.organizationId, email: input.email, status: "PENDING" },
      select: { expiresAt: true },
    });
    if (pending) {
      throw new ConflictError(
        pending.expiresAt > now
          ? "Ya hay una invitación pendiente para ese correo. Podés reenviarla."
          : "Hay una invitación vencida para ese correo. Reenviala o revocala.",
      );
    }

    const clientIds = await requireOrgClients(tx, actor.organizationId, input.clientScope === "SELECTED" ? input.clientIds : []);

    const seats = await countSeats(tx, actor.organizationId, org.seatLimit, now);
    if (seats.available <= 0) throw seatsFull();

    const created = await tx.organizationInvitation.create({
      data: {
        organizationId: actor.organizationId,
        email: input.email,
        role: input.role,
        clientScope: input.clientScope,
        modules: input.modules,
        clientIds,
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
        invitedById: actor.profileId,
      },
      select: { id: true, email: true },
    });
    await recordAudit(tx, {
      organizationId: actor.organizationId,
      actorProfileId: actor.profileId,
      action: "member.invite",
      targetType: "OrganizationInvitation",
      targetId: created.id,
      metadata: {
        role: input.role,
        clientScope: input.clientScope,
        clientCount: clientIds.length,
        modules: modulesText(input.modules),
      },
    });
    return created;
  }, { maxWait: 5000, timeout: 12000 });

  const delivery = await deliver(invitation.id, invitation.email, redirectTo);
  return { invitationId: invitation.id, delivery };
}

/** Envía y, si salió, registra el envío (sólo si la invitación sigue PENDING). */
async function deliver(invitationId: string, email: string, redirectTo: string): Promise<DeliveryStatus> {
  const result = await sendInvitationEmail(email, redirectTo);
  if (result.status === "SENT") {
    await prisma.organizationInvitation.updateMany({
      where: { id: invitationId, status: "PENDING" },
      data: {
        lastSentAt: new Date(),
        sendCount: { increment: 1 },
        ...(result.authUserId ? { authUserId: result.authUserId } : {}),
      },
    });
  }
  return result.status;
}

// ── Reenviar / revocar ────────────────────────────────────────────────────

export async function resendInvitation(actor: UsersActor, invitationId: string, redirectTo: string): Promise<InviteOutcome> {
  const now = new Date();
  const inv = await prisma.$transaction(async (tx) => {
    const org = await lockOrganization(tx, actor.organizationId);
    if (!org) throw new NotFoundError();
    const row = await tx.organizationInvitation.findFirst({
      where: { id: invitationId, organizationId: actor.organizationId },
      select: { id: true, email: true, status: true, expiresAt: true, lastSentAt: true },
    });
    if (!row) throw new NotFoundError();
    if (row.status !== "PENDING") throw new ConflictError("La invitación ya no está pendiente.");
    if (row.lastSentAt && now.getTime() - row.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
      throw new ConflictError("La invitación se acaba de enviar. Esperá un minuto antes de reenviarla.");
    }
    if (row.expiresAt <= now) {
      // Vencida: no ocupa plaza; reenviarla la vuelve a ocupar.
      const seats = await countSeats(tx, actor.organizationId, org.seatLimit, now);
      if (seats.available <= 0) throw seatsFull();
    }
    await tx.organizationInvitation.update({
      where: { id: row.id },
      data: { expiresAt: new Date(now.getTime() + INVITATION_TTL_MS) },
    });
    await recordAudit(tx, {
      organizationId: actor.organizationId,
      actorProfileId: actor.profileId,
      action: "member.invite_resend",
      targetType: "OrganizationInvitation",
      targetId: row.id,
      metadata: {},
    });
    return row;
  }, { maxWait: 5000, timeout: 12000 });
  const delivery = await deliver(inv.id, inv.email, redirectTo);
  return { invitationId: inv.id, delivery };
}

export async function revokeInvitation(actor: UsersActor, invitationId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const org = await lockOrganization(tx, actor.organizationId);
    if (!org) throw new NotFoundError();
    const row = await tx.organizationInvitation.findFirst({
      where: { id: invitationId, organizationId: actor.organizationId },
      select: { id: true, status: true },
    });
    if (!row) throw new NotFoundError();
    if (row.status !== "PENDING") throw new ConflictError("La invitación ya no está pendiente.");
    await tx.organizationInvitation.update({
      where: { id: row.id },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    await recordAudit(tx, {
      organizationId: actor.organizationId,
      actorProfileId: actor.profileId,
      action: "member.invite_revoke",
      targetType: "OrganizationInvitation",
      targetId: row.id,
      metadata: {},
    });
  }, { maxWait: 5000, timeout: 12000 });
}

// ── Miembros: permisos, desactivar, reactivar ─────────────────────────────

async function lockTargetMembership(tx: Tx, actor: UsersActor, membershipId: string) {
  const org = await lockOrganization(tx, actor.organizationId);
  if (!org) throw new NotFoundError();
  const m = await tx.membership.findFirst({
    where: { id: membershipId, organizationId: actor.organizationId },
    select: {
      id: true,
      profileId: true,
      role: true,
      status: true,
      clientScope: true,
      modules: true,
      clientAccess: { select: { clientId: true } },
    },
  });
  if (!m) throw new NotFoundError();
  if (m.profileId === actor.profileId) throw new ForbiddenError(SELF_MESSAGE);
  if (m.role === "OWNER") throw new ForbiddenError(OWNER_PROTECTED_MESSAGE);
  return { org, m };
}

export async function updateMemberPermissions(
  actor: UsersActor,
  membershipId: string,
  input: PermissionsInput,
): Promise<{ changed: string[] }> {
  return prisma.$transaction(async (tx) => {
    const { m } = await lockTargetMembership(tx, actor, membershipId);
    const clientIds = await requireOrgClients(tx, actor.organizationId, input.clientScope === "SELECTED" ? input.clientIds : []);

    const before = new Set(m.clientAccess.map((c) => c.clientId));
    const clientsChanged =
      input.clientScope === "SELECTED" &&
      (before.size !== clientIds.length || clientIds.some((id) => !before.has(id)));
    const changed: string[] = [];
    if (m.role !== input.role) changed.push("role");
    if (m.clientScope !== input.clientScope) changed.push("clientScope");
    if (clientsChanged) changed.push("clients");
    if (modulesText(m.modules ?? []) !== modulesText(input.modules)) changed.push("modules");
    if (changed.length === 0) return { changed };

    await tx.membership.update({
      where: { id: m.id },
      data: { role: input.role, clientScope: input.clientScope, modules: input.modules },
    });
    if (changed.includes("clientScope") || changed.includes("clients")) {
      await replaceClientAccess(tx, m.id, actor.organizationId, input.clientScope, clientIds);
    }
    await recordAudit(tx, {
      organizationId: actor.organizationId,
      actorProfileId: actor.profileId,
      action: "member.permissions_change",
      targetType: "Membership",
      targetId: m.id,
      metadata: {
        changedFields: changed.join(","),
        roleBefore: m.role,
        roleAfter: input.role,
        clientScopeBefore: m.clientScope,
        clientScopeAfter: input.clientScope,
        clientCount: clientIds.length,
        modules: modulesText(input.modules),
      },
    });
    return { changed };
  }, { maxWait: 5000, timeout: 12000 });
}

export async function disableMember(actor: UsersActor, membershipId: string): Promise<{ changed: boolean }> {
  return prisma.$transaction(async (tx) => {
    const { m } = await lockTargetMembership(tx, actor, membershipId);
    if (m.status === "DISABLED") return { changed: false };
    await tx.membership.update({ where: { id: m.id }, data: { status: "DISABLED", disabledAt: new Date() } });
    await recordAudit(tx, {
      organizationId: actor.organizationId,
      actorProfileId: actor.profileId,
      action: "member.disable",
      targetType: "Membership",
      targetId: m.id,
      metadata: { role: m.role },
    });
    return { changed: true };
  }, { maxWait: 5000, timeout: 12000 });
}

export async function enableMember(actor: UsersActor, membershipId: string): Promise<{ changed: boolean }> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const { org, m } = await lockTargetMembership(tx, actor, membershipId);
    if (m.status === "ACTIVE") return { changed: false };
    const elsewhere = await tx.membership.count({
      where: { profileId: m.profileId, status: "ACTIVE", organizationId: { not: actor.organizationId } },
    });
    if (elsewhere > 0) throw new ConflictError("Esa cuenta ya tiene acceso activo a otro estudio.");
    const seats = await countSeats(tx, actor.organizationId, org.seatLimit, now);
    if (seats.available <= 0) throw seatsFull();
    await tx.membership.update({ where: { id: m.id }, data: { status: "ACTIVE", disabledAt: null } });
    await recordAudit(tx, {
      organizationId: actor.organizationId,
      actorProfileId: actor.profileId,
      action: "member.enable",
      targetType: "Membership",
      targetId: m.id,
      metadata: { role: m.role },
    });
    return { changed: true };
  }, { maxWait: 5000, timeout: 12000 });
}

// ── Aceptar (la persona invitada) ─────────────────────────────────────────

export const ACCEPT_ERRORS = {
  NONE: "No encontramos una invitación vigente para tu correo. Pedile al estudio que te la reenvíe.",
  MANY: "Tenés más de una invitación vigente. Pedile al estudio que revoque las que no correspondan.",
  OTHER_ORG: "Tu cuenta ya tiene acceso activo a otro estudio.",
} as const;

export interface AcceptIdentity {
  /** auth.users.id verificado (claims.sub). */
  sub: string;
  /** Correo del claim verificado. */
  email: string | null;
}

/**
 * Convierte la invitación PENDING vigente del correo verificado en una
 * Membership ACTIVE. La invitación ya ocupaba una plaza: aceptar no suma.
 * Si la invitación guardó el auth.users.id, debe coincidir con la sesión.
 */
async function acceptableInvitations(identity: AcceptIdentity) {
  const email = normalizeEmail(identity.email);
  if (!email) return { email: null, candidates: [] };
  const candidates = await prisma.organizationInvitation.findMany({
    where: {
      email,
      status: "PENDING",
      expiresAt: { gt: new Date() },
      OR: [{ authUserId: null }, { authUserId: identity.sub }],
    },
    select: { id: true, organizationId: true },
  });
  return { email, candidates };
}

/** Pre-chequeo sin escribir: ¿hay una invitación vigente para esta identidad? */
export async function hasAcceptableInvitation(identity: AcceptIdentity): Promise<boolean> {
  const { candidates } = await acceptableInvitations(identity);
  return candidates.length > 0;
}

export async function acceptInvitation(identity: AcceptIdentity): Promise<{ organizationId: string; membershipId: string }> {
  const { email, candidates } = await acceptableInvitations(identity);
  if (!email) throw new ConflictError(ACCEPT_ERRORS.NONE);
  if (candidates.length === 0) throw new ConflictError(ACCEPT_ERRORS.NONE);
  if (candidates.length > 1) throw new ConflictError(ACCEPT_ERRORS.MANY);
  const { id: invitationId, organizationId } = candidates[0];

  return prisma.$transaction(async (tx) => {
    const org = await lockOrganization(tx, organizationId);
    if (!org) throw new ConflictError(ACCEPT_ERRORS.NONE);
    // Relectura bajo el bloqueo: pudo revocarse o vencer mientras tanto.
    const inv = await tx.organizationInvitation.findFirst({
      where: { id: invitationId, organizationId, email, status: "PENDING", expiresAt: { gt: new Date() } },
    });
    if (!inv) throw new ConflictError(ACCEPT_ERRORS.NONE);
    if (inv.authUserId && inv.authUserId !== identity.sub) throw new ConflictError(ACCEPT_ERRORS.NONE);

    const elsewhere = await tx.membership.count({
      where: { profileId: identity.sub, status: "ACTIVE", organizationId: { not: organizationId } },
    });
    if (elsewhere > 0) throw new ConflictError(ACCEPT_ERRORS.OTHER_ORG);

    await tx.profile.upsert({
      where: { id: identity.sub },
      create: { id: identity.sub, email },
      update: { email },
    });

    const clientIds =
      inv.clientScope === "SELECTED"
        ? (await tx.client.findMany({ where: { organizationId, id: { in: inv.clientIds } }, select: { id: true } })).map((c) => c.id)
        : [];
    const perms: { role: Role; clientScope: ClientScope; modules: AppModule[] } = {
      role: inv.role,
      clientScope: inv.clientScope,
      modules: inv.modules,
    };

    const existing = await tx.membership.findUnique({
      where: { profileId_organizationId: { profileId: identity.sub, organizationId } },
      select: { id: true, role: true },
    });
    let membershipId: string;
    if (existing) {
      // Nunca se degrada a un OWNER por invitación (además, el trigger lo impide).
      if (existing.role === "OWNER") throw new ConflictError("Tu cuenta ya es propietaria de este estudio.");
      await tx.membership.update({
        where: { id: existing.id },
        data: { ...perms, status: "ACTIVE", disabledAt: null },
      });
      membershipId = existing.id;
    } else {
      const created = await tx.membership.create({
        data: { profileId: identity.sub, organizationId, ...perms },
        select: { id: true },
      });
      membershipId = created.id;
    }
    await replaceClientAccess(tx, membershipId, organizationId, inv.clientScope, clientIds);

    await tx.organizationInvitation.update({
      where: { id: inv.id },
      data: { status: "ACCEPTED", acceptedAt: new Date(), authUserId: identity.sub },
    });
    await recordAudit(tx, {
      organizationId,
      actorProfileId: identity.sub,
      action: "member.invite_accept",
      targetType: "OrganizationInvitation",
      targetId: inv.id,
      metadata: { membershipId, role: inv.role },
    });
    return { organizationId, membershipId };
  }, { maxWait: 5000, timeout: 12000 });
}

// ── Vista del propietario ─────────────────────────────────────────────────

export async function loadUsersOverview(actor: UsersActor): Promise<UsersOverview> {
  const now = new Date();
  const [org, members, invitations, clients] = await Promise.all([
    prisma.organization.findUnique({ where: { id: actor.organizationId }, select: { seatLimit: true } }),
    prisma.membership.findMany({
      where: { organizationId: actor.organizationId },
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        profileId: true,
        role: true,
        status: true,
        clientScope: true,
        modules: true,
        createdAt: true,
        profile: { select: { email: true, fullName: true } },
        clientAccess: { select: { clientId: true } },
      },
    }),
    prisma.organizationInvitation.findMany({
      where: { organizationId: actor.organizationId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, role: true, clientScope: true, clientIds: true, modules: true, expiresAt: true, lastSentAt: true },
    }),
    prisma.client.findMany({
      where: { organizationId: actor.organizationId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, cuit: true },
    }),
  ]);
  if (!org) throw new NotFoundError();
  const seats = await countSeats(prisma, actor.organizationId, org.seatLimit, now);
  return {
    seats,
    members: members.map((m) => ({
      id: m.id,
      email: m.profile.email,
      fullName: m.profile.fullName,
      role: m.role,
      status: m.status,
      clientScope: m.role === "OWNER" ? "ALL" : m.clientScope,
      clientIds: m.clientAccess.map((c) => c.clientId),
      modules: m.role === "OWNER" ? [...APP_MODULES] : (m.modules ?? []),
      isSelf: m.profileId === actor.profileId,
      createdAt: m.createdAt.toISOString(),
    })),
    invitations: invitations.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      clientScope: i.clientScope,
      clientCount: i.clientIds.length,
      modules: i.modules,
      expiresAt: i.expiresAt.toISOString(),
      expired: i.expiresAt <= now,
      lastSentAt: i.lastSentAt ? i.lastSentAt.toISOString() : null,
    })),
    clients,
  };
}
