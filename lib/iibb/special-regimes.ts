/**
 * Regímenes especiales que el sistema NO calcula y sólo advierte.
 *
 * ARBA — Ley 15558 (Impositiva 2026), art. 163, reglamentado por RN ARBA 35/2025
 * (modifica la RN 31/2020): adicional extraordinario de IIBB, por tonelada de
 * mercadería cargada, descargada o removida, para la explotación de terminales
 * portuarias en puertos de la provincia, con tope del 5 % de la base del anticipo.
 * Decisión del estudio (26/11/2026): sólo advertencia, se liquida aparte.
 */
export const ARBA_JURISDICTION = "902";

export const ARBA_ART163_CODES: ReadonlySet<string> = new Set([
    "521020", "522010", "522020", "522092", "522099", "524210", "524290",
    "523011", "523019", "523031", "523032", "523039", "523090",
]);

export const ARBA_ART163_NOTICE =
    "Adicional del art. 163 de la Ley 15558 (ARBA 2026, RN ARBA 35/2025): si la actividad corresponde a la explotación de terminales portuarias en la provincia, corre un importe extra por tonelada cargada, descargada o removida (tope 5 % de la base). El sistema no lo calcula: liquidalo aparte.";

/** Códigos de la lista que el cliente tiene en ARBA. */
export function arbaArt163Codes(jurisdictionCode: string, codes: Iterable<string>): string[] {
    if (jurisdictionCode !== ARBA_JURISDICTION) return [];
    return [...new Set([...codes].filter((c) => ARBA_ART163_CODES.has(c)))].sort();
}
