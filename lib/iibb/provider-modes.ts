/** Modos de reparto de prestadores (sin dependencias: se usa también en el navegador). */
export type ProviderMode = "SINGLE" | "BY_VAT_RATE" | "MANUAL";
export const PROVIDER_MODES: readonly ProviderMode[] = ["SINGLE", "BY_VAT_RATE", "MANUAL"];
/** Claves del mapa por alícuota: códigos ARCA de alícuota y las dos partes sin alícuota. */
export const RATE_MAP_KEYS = ["5", "4", "6", "8", "9", "3", "EXENTO", "SIN_IVA"] as const;
export const RATE_MAP_LABELS: Record<(typeof RATE_MAP_KEYS)[number], string> = {
    "5": "21 %", "4": "10,5 %", "6": "27 %", "8": "5 %", "9": "2,5 %", "3": "0 %", EXENTO: "Exento / no gravado", SIN_IVA: "Sin IVA discriminado (factura C)",
};
export type RateMap = Partial<Record<(typeof RATE_MAP_KEYS)[number], string>>;

