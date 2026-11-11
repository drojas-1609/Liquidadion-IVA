import type { ArcaPersonDTO } from "./arca-lookup-client";
import { lookupCuitFrom } from "./invoice-counterparty-lookup";

export function supplierAccountCuit(docType: number | null, docNumber: string | null) {
    return lookupCuitFrom(docType, docNumber ?? "")?.replaceAll("-", "") ?? null;
}

const ACCOUNT_BY_ACTIVITY: ReadonlyArray<[RegExp, string]> = [
    [/software|informatic|programacion/, "Software y servicios informáticos"],
    [/telecomunic|internet/, "Telecomunicaciones"],
    [/seguro/, "Seguros"],
    [/bancari|intermediacion financiera/, "Gastos bancarios"],
    [/electricidad|energia electrica/, "Electricidad"],
    [/contab|auditoria|asesoria fiscal/, "Honorarios contables"],
    [/limpieza/, "Limpieza"],
    [/transporte|logistica/, "Transporte y logística"],
    [/alquiler|locacion/, "Alquileres"],
];

export function suggestSupplierAccounts(activities: ArcaPersonDTO["activities"]) {
    return activities.map(({ code, description }) => {
        const normalized = description.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
        return {
            code,
            description,
            account: ACCOUNT_BY_ACTIVITY.find(([pattern]) => pattern.test(normalized))?.[1] ?? "Compras y servicios a clasificar",
        };
    });
}
