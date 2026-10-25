import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { buildClientUpdateInput, CLIENT_UPDATABLE_FIELDS, type ClientUpdateFields } from "@/lib/api-input";
import { serializeClient } from "@/lib/serializers";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    parseJsonBody,
    withApiAuthz,
} from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { iibbProfileChanged, loadIibbProfile, replaceIibbProfile } from "@/lib/client-iibb-store";
import { lockClientForUpdate, nextClientVersion } from "@/lib/client-lock";
import { summarizeStoredProfile, unconfirmedRemovals } from "@/lib/client-profile";
import { jurisdictionLabel } from "@/lib/iibb/jurisdictions";
import { ROLES_CLIENT_MANAGE, ROLES_DELETE } from "@/lib/auth/roles";
import { AuthError, ConflictError, NotFoundError, ValidationError } from "@/lib/auth/errors";

type Ctx = { params: Promise<{ id: string }> };

const CLIENT_HAS_PERIODS_MESSAGE =
    "El cliente tiene períodos asociados y no se puede eliminar.";

const CLIENT_STALE_MESSAGE =
    "El cliente fue modificado por otra persona después de que abriste el formulario. Tus cambios no se guardaron.";

function isPrismaError(err: unknown, code: string): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === code;
}

type ClientRow = NonNullable<Awaited<ReturnType<typeof prisma.client.findFirst>>>;

/** Nombres de los campos escalares cuyo valor cambia respecto de la fila actual. */
function changedFieldsOf(current: ClientRow, data: Omit<ClientUpdateFields, "phone" | "contactEmail" | "iibb">): string[] {
    return CLIENT_UPDATABLE_FIELDS.filter((field) => {
        if (!(field in data)) return false;
        if (field === "defaultIibbRate") return !current.defaultIibbRate.equals(data.defaultIibbRate!);
        return current[field] !== data[field];
    });
}

// PATCH /api/clients/[id] — edición parcial de un cliente (OWNER / ADMIN).
//
// Orden (brief §7.1): auth -> organización -> rol -> parseo -> validación
// (incluida `expectedUpdatedAt`, 422) -> transacción: FOR UPDATE de la fila
// del cliente por id + organización (otra org o inexistente: MISMO 404) ->
// versión (`updatedAt` distinto: 409 CONFLICT con field "expectedUpdatedAt",
// sin escrituras ni AuditLog) -> contactos y quitas confirmadas (422) ->
// update (versión estrictamente posterior) + ficha IIBB + AuditLog.
//
// Concurrencia optimista: TODA edición (campos generales, contactos o ficha
// IIBB) envía la versión que vio el formulario y TODA escritura avanza la
// versión del cliente, aunque sólo cambie la ficha IIBB. El token nunca se
// renueva solo: un formulario viejo recibe 409 hasta que el usuario recarga.
//
// P2002 sobre @@unique([organizationId, cuit]) -> withApiAuthz -> 409 CONFLICT.
export const PATCH = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_CLIENT_MANAGE);

    const body = await parseJsonBody(request);
    const parsed = buildClientUpdateInput(body);
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);

    try {
        const updated = await prisma.$transaction(async (tx) => {
            const { expectedUpdatedAt, phone, contactEmail, iibb, ...scalars } = parsed.data;
            const locked = await lockClientForUpdate(tx, id, organizationId);
            if (!locked) throw new NotFoundError();
            if (locked.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
                throw new AuthError("CONFLICT", 409, CLIENT_STALE_MESSAGE, "expectedUpdatedAt");
            }
            const current = await tx.client.findFirst({ where: { id, organizationId } });
            if (!current) throw new NotFoundError();

            const changed = changedFieldsOf(current, scalars);
            const data: Prisma.ClientUncheckedUpdateInput = {};
            for (const field of changed) Object.assign(data, { [field]: scalars[field as keyof typeof scalars] });

            // Contactos: un valor confirmado no se vacía en silencio; en un
            // cliente histórico sin contacto, el vacío no es un cambio (así se
            // pueden editar otros campos sin completarlo todavía).
            for (const [field, next] of [["phone", phone], ["contactEmail", contactEmail]] as const) {
                if (next === undefined) continue;
                const stored = current[field];
                if (next === null) {
                    if (stored !== null) {
                        throw new ValidationError("no se puede vaciar un contacto ya confirmado; reemplazalo por otro valor", field);
                    }
                    continue;
                }
                if (next !== stored) {
                    changed.push(field);
                    data[field] = next;
                }
            }

            // Perfil IIBB: reemplazo total, sólo si cambió. Las quitas de
            // información guardada requieren una confirmación EXACTA del
            // conjunto que se pierde (calculado sobre la fila bloqueada).
            let replaceProfile = false;
            if (iibb !== undefined) {
                const stored = await loadIibbProfile(tx, id, organizationId);
                if (iibbProfileChanged(current.iibbRegistration, stored, iibb)) {
                    const pending = unconfirmedRemovals(summarizeStoredProfile(stored), iibb);
                    if (pending.jurisdictions.length > 0) {
                        throw new ValidationError(
                            `confirmá quitar ${pending.jurisdictions.map(jurisdictionLabel).join(", ")}: se perderán actividades o alícuotas asociadas`,
                            "iibb.confirmRemovedJurisdictions",
                        );
                    }
                    if (pending.activities.length > 0) {
                        throw new ValidationError("confirmá quitar las actividades eliminadas y sus alícuotas", "iibb.confirmRemovedActivities");
                    }
                    if (iibb.registration !== current.iibbRegistration) {
                        changed.push("iibbRegistration");
                        data.iibbRegistration = iibb.registration;
                    }
                    changed.push("iibbProfile");
                    replaceProfile = true;
                }
            }

            if (changed.length === 0) return current; // sin cambios: ni escritura ni AuditLog

            const client = await tx.client.update({
                where: { id_organizationId: { id, organizationId } },
                // La versión avanza siempre, también si sólo cambió la ficha IIBB.
                data: { ...data, updatedById: profileId, updatedAt: nextClientVersion(locked.updatedAt, Date.now()) },
            });
            if (replaceProfile && iibb) await replaceIibbProfile(tx, { clientId: id, organizationId, profile: iibb });
            await recordAudit(tx, {
                organizationId,
                actorProfileId: profileId,
                action: "client.update",
                targetType: "Client",
                targetId: client.id,
                // Sólo NOMBRES de campos, la condición y la inscripción IIBB
                // resultantes. SIN cuit ni contactos.
                metadata: { changedFields: changed.join(","), condition: client.condition, iibbRegistration: client.iibbRegistration },
            });
            return client;
        });
        return NextResponse.json(serializeClient(updated));
    } catch (err) {
        // La fila desapareció entre la lectura y la escritura.
        if (isPrismaError(err, "P2025")) throw new NotFoundError();
        throw err;
    }
});

// DELETE /api/clients/[id] — eliminación de un cliente (OWNER / ADMIN).
//
// Si el cliente tiene períodos -> 409 CONFLICT, sin borrar ni auditar. Si un
// período se crea en paralelo, la FK Restrict (P2003) también responde 409.
export const DELETE = withApiAuthz(async (_request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_DELETE);

    try {
        await prisma.$transaction(async (tx) => {
            const current = await tx.client.findFirst({ where: { id, organizationId } });
            if (!current) throw new NotFoundError();

            const periods = await tx.period.count({ where: { clientId: id, organizationId } });
            if (periods > 0) throw new ConflictError(CLIENT_HAS_PERIODS_MESSAGE);

            await tx.client.delete({ where: { id_organizationId: { id, organizationId } } });
            await recordAudit(tx, {
                organizationId,
                actorProfileId: profileId,
                action: "client.delete",
                targetType: "Client",
                targetId: id,
                metadata: { condition: current.condition }, // SIN cuit, nombre ni dirección
            });
        });
    } catch (err) {
        if (isPrismaError(err, "P2003")) throw new ConflictError(CLIENT_HAS_PERIODS_MESSAGE);
        if (isPrismaError(err, "P2025")) throw new NotFoundError();
        throw err;
    }
    return new NextResponse(null, { status: 204 });
});
