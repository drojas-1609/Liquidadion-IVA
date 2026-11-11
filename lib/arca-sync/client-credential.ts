import "server-only";
import type { Prisma } from "@prisma/client";
import { normalizeCuit } from "../cuit";
import { ForbiddenError, ValidationError } from "../auth/errors";
import { ROLES_CONFIG } from "../auth/roles";
import { credentialKey, sealCredential } from "./credential-crypto";

export function parseClientCredential(body: unknown, role: (typeof ROLES_CONFIG)[number]) {
    const input = (body as { arcaCredential?: unknown } | null)?.arcaCredential;
    if (input === undefined) return undefined;
    if (!ROLES_CONFIG.includes(role)) throw new ForbiddenError();
    const value = input as { loginCuit?: unknown; password?: unknown } | null;
    const cuit = normalizeCuit(value?.loginCuit);
    if (!cuit.ok) throw new ValidationError("Ingresá un CUIT de acceso válido.", "arcaCredential");
    if (typeof value?.password !== "string" || !value.password.trim() || value.password.length > 256) {
        throw new ValidationError("Ingresá la clave fiscal.", "arcaCredential");
    }
    const key = credentialKey();
    if (!key) throw new ValidationError("El almacenamiento seguro de ARCA aún no está configurado.", "arcaCredential");
    return { credential: { cuit: cuit.value.replace(/\D/g, ""), password: value.password }, key };
}

export async function saveClientCredential(
    tx: Prisma.TransactionClient,
    client: { id: string; organizationId: string; cuit: string },
    input: NonNullable<ReturnType<typeof parseClientCredential>>,
) {
    const identity = { clientId: client.id, organizationId: client.organizationId };
    const targetCuit = client.cuit.replace(/\D/g, "");
    if (/^(30|33|34)/.test(targetCuit) && targetCuit === input.credential.cuit) {
        throw new ValidationError("Para una empresa, ingresá el CUIT del administrador autorizado.", "arcaCredential");
    }
    const envelope = sealCredential(input.credential, { ...identity, targetCuit }, input.key);
    await tx.arcaClientCredential.upsert({
        where: { clientId_organizationId: identity },
        create: { ...identity, targetCuit, envelope },
        update: { targetCuit, envelope },
    });
}
