import "server-only";
import { Prisma } from "@prisma/client";
import { parseRate } from "./validation/decimal";
import { activityKey, type IibbProfileData } from "./client-profile";
import type { IibbRegistration } from "./iibb/registration";

/**
 * Persistencia del perfil IIBB informativo de un cliente (jurisdicciones,
 * actividades y alícuotas por actividad–jurisdicción).
 *
 * Todo se ejecuta dentro de la transacción del llamador y SIEMPRE acotado por
 * `clientId` + `organizationId` (las FKs compuestas de la base impiden además
 * relaciones entre organizaciones). Nunca toca `Client.defaultIibbRate` ni el
 * cálculo de la liquidación.
 */

type Tx = Pick<Prisma.TransactionClient, "clientJurisdiction" | "clientActivity" | "clientActivityRate">;

export interface StoredIibbProfile {
    jurisdictions: Array<{ code: string; headquarters: boolean }>;
    activities: Array<{
        nomenclator: IibbProfileData["activities"][number]["nomenclator"];
        nomenclatorJurisdiction: string;
        nomenclatorReference: string | null;
        code: string;
        description: string;
        rates: Array<{ jurisdiction: string; rate: string | null }>;
    }>;
}

/** Decimal -> string canónico ("3.5", "0"); null se conserva (sin informar). */
function rateString(rate: Prisma.Decimal | null): string | null {
    return rate === null ? null : rate.toString();
}

export async function loadIibbProfile(tx: Tx, clientId: string, organizationId: string): Promise<StoredIibbProfile> {
    const where = { clientId, organizationId };
    // Secuencial: una transacción interactiva ejecuta una consulta por vez.
    const jurisdictions = await tx.clientJurisdiction.findMany({ where, orderBy: { jurisdictionCode: "asc" } });
    const activities = await tx.clientActivity.findMany({ where, orderBy: [{ nomenclator: "asc" }, { code: "asc" }] });
    const rates = await tx.clientActivityRate.findMany({ where, orderBy: { jurisdictionCode: "asc" } });
    return {
        jurisdictions: jurisdictions.map((j) => ({ code: j.jurisdictionCode, headquarters: j.isHeadquarters })),
        activities: activities.map((a) => ({
            nomenclator: a.nomenclator,
            nomenclatorJurisdiction: a.nomenclatorJurisdiction,
            nomenclatorReference: a.nomenclatorReference,
            code: a.code,
            description: a.description,
            rates: rates
                .filter((r) => r.activityId === a.id)
                .map((r) => ({ jurisdiction: r.jurisdictionCode, rate: rateString(r.rate) })),
        })),
    };
}

/** Alícuota normalizada para comparar ("3.50" == "3.5"); null = sin informar. */
function canonRate(rate: string | null): string | null {
    if (rate === null) return null;
    const parsed = parseRate(rate);
    return parsed.ok ? parsed.value.toString() : rate;
}

function canonical(registration: IibbRegistration | null, p: Pick<StoredIibbProfile, "jurisdictions" | "activities">): string {
    return JSON.stringify({
        registration,
        jurisdictions: [...p.jurisdictions].sort((a, b) => a.code.localeCompare(b.code)),
        activities: [...p.activities]
            .map((a) => ({
                ...a,
                rates: [...a.rates]
                    .map((r) => ({ jurisdiction: r.jurisdiction, rate: canonRate(r.rate) }))
                    .sort((x, y) => x.jurisdiction.localeCompare(y.jurisdiction)),
            }))
            .sort((x, y) => activityKey(x).localeCompare(activityKey(y))),
    });
}

/** true si el perfil nuevo difiere del guardado (inscripción incluida). */
export function iibbProfileChanged(
    storedRegistration: IibbRegistration | null,
    stored: StoredIibbProfile,
    next: IibbProfileData,
): boolean {
    return canonical(storedRegistration, stored) !== canonical(next.registration, next);
}

/**
 * Reemplaza jurisdicciones, actividades y alícuotas del cliente por las del
 * perfil validado. El llamador ya bloqueó la fila del cliente, verificó su
 * versión y exigió confirmaciones exactas de las quitas (`unconfirmedRemovals`).
 * Orden: alícuotas -> actividades -> jurisdicciones (borrado) y
 * jurisdicciones -> actividades -> alícuotas (alta).
 */
export async function replaceIibbProfile(
    tx: Tx,
    args: { clientId: string; organizationId: string; profile: IibbProfileData },
): Promise<void> {
    const { clientId, organizationId, profile } = args;
    const where = { clientId, organizationId };
    await tx.clientActivityRate.deleteMany({ where });
    await tx.clientActivity.deleteMany({ where });
    await tx.clientJurisdiction.deleteMany({ where });

    if (profile.jurisdictions.length > 0) {
        await tx.clientJurisdiction.createMany({
            data: profile.jurisdictions.map((j) => ({
                clientId,
                organizationId,
                jurisdictionCode: j.code,
                isHeadquarters: j.headquarters,
            })),
        });
    }
    for (const a of profile.activities) {
        const created = await tx.clientActivity.create({
            data: {
                clientId,
                organizationId,
                nomenclator: a.nomenclator,
                nomenclatorJurisdiction: a.nomenclatorJurisdiction,
                nomenclatorReference: a.nomenclatorReference,
                code: a.code,
                description: a.description,
            },
            select: { id: true },
        });
        if (a.rates.length > 0) {
            await tx.clientActivityRate.createMany({
                data: a.rates.map((r) => {
                    let rate: Prisma.Decimal | null = null;
                    if (r.rate !== null) {
                        const parsed = parseRate(r.rate);
                        // validateIibbProfile ya aplicó las mismas reglas; esto no debería fallar.
                        if (!parsed.ok) throw new Error("alícuota inválida tras la validación");
                        rate = parsed.value;
                    }
                    return { clientId, organizationId, activityId: created.id, jurisdictionCode: r.jurisdiction, rate };
                }),
            });
        }
    }
}
