import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { buildClientUpdateInput, CLIENT_UPDATABLE_FIELDS, type ClientUpdateData } from "@/lib/api-input";
import { serializeClient } from "@/lib/serializers";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    parseJsonBody,
    withApiAuthz,
} from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_CLIENT_MANAGE, ROLES_DELETE } from "@/lib/auth/roles";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/auth/errors";

type Ctx = { params: Promise<{ id: string }> };

const CLIENT_HAS_PERIODS_MESSAGE =
    "El cliente tiene períodos asociados y no se puede eliminar.";

function isPrismaError(err: unknown, code: string): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === code;
}

type ClientRow = NonNullable<Awaited<ReturnType<typeof prisma.client.findFirst>>>;

/** Nombres de los campos cuyo valor cambia respecto de la fila actual. */
function changedFieldsOf(current: ClientRow, data: ClientUpdateData): string[] {
    return CLIENT_UPDATABLE_FIELDS.filter((field) => {
        if (!(field in data)) return false;
        if (field === "defaultIibbRate") return !current.defaultIibbRate.equals(data.defaultIibbRate!);
        return current[field] !== data[field];
    });
}

// PATCH /api/clients/[id] — edición parcial de un cliente (OWNER / ADMIN).
//
// Orden (brief §7.1): auth -> organización -> rol -> parseo -> validación ->
// cliente acotado a la organización activa (otra org o inexistente: MISMO 404)
// -> escritura + AuditLog client.update en una única transacción.
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
            const current = await tx.client.findFirst({ where: { id, organizationId } });
            if (!current) throw new NotFoundError();

            const changed = changedFieldsOf(current, parsed.data);
            if (changed.length === 0) return current; // sin cambios: ni escritura ni AuditLog

            const client = await tx.client.update({
                where: { id_organizationId: { id, organizationId } },
                data: { ...parsed.data, updatedById: profileId },
            });
            await recordAudit(tx, {
                organizationId,
                actorProfileId: profileId,
                action: "client.update",
                targetType: "Client",
                targetId: client.id,
                // Sólo NOMBRES de campos y la condición resultante. SIN cuit.
                metadata: { changedFields: changed.join(","), condition: client.condition },
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
