/**
 * Inclusión del período en el Régimen TurIVA desde la UI: envío del PATCH,
 * traducción de errores de la API (`{ error: { code, message }, field? }`) y
 * controlador del toggle sin React (evita dobles envíos y NO aplica cambios
 * optimistas: el estado cambia sólo con la respuesta 200 de la API).
 *
 * La API es la autoridad: acá no se cuentan comprobantes ni se replica la
 * regla que impide desactivar con comprobantes 195–197 (la API responde 409).
 * Nunca se convierte un objeto a string de forma implícita.
 */
import { readApiError } from "@/lib/new-client-submit";
import { PERIOD_NOT_FOUND_ERROR } from "@/lib/period-mutations";

/** Ancla de la tarjeta TurIVA en la página del período (el formulario de comprobantes enlaza acá). */
export const TURIVA_SECTION_ID = "turiva";

export const TURIVA_SETTING_GENERIC_ERROR = "Ocurrió un error inesperado al guardar la configuración TurIVA.";
export const TURIVA_SETTING_BAD_REQUEST_ERROR = "No se pudo procesar el cambio. Intentá de nuevo.";
export const TURIVA_SETTING_FORBIDDEN_ERROR = "No tenés permisos para modificar la configuración del período.";

export function turivaSettingErrorMessage(status: number, body: unknown): string {
    const apiError = readApiError(body);
    // 409: el período tiene comprobantes 195–197, o está siendo modificado por
    // otra operación (PERIOD_BUSY); se muestra el mensaje exacto de la API.
    if (status === 409) return apiError?.message ?? TURIVA_SETTING_GENERIC_ERROR;
    if (status === 400 || status === 422) return TURIVA_SETTING_BAD_REQUEST_ERROR;
    if (status === 403) return TURIVA_SETTING_FORBIDDEN_ERROR;
    if (status === 404) return PERIOD_NOT_FOUND_ERROR;
    return TURIVA_SETTING_GENERIC_ERROR;
}

export type TurivaSettingResult = { ok: true; turivaIncluded: boolean } | { ok: false; message: string };

/** PATCH /api/periods/[id]/vat-settings con el cuerpo exacto `{ turivaIncluded }`. */
export async function submitTurivaSetting(
    periodId: string,
    turivaIncluded: boolean,
    fetchImpl: typeof fetch = fetch,
): Promise<TurivaSettingResult> {
    let res: Response;
    try {
        res = await fetchImpl(`/api/periods/${encodeURIComponent(periodId)}/vat-settings`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ turivaIncluded }),
        });
    } catch {
        return { ok: false, message: TURIVA_SETTING_GENERIC_ERROR };
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, message: turivaSettingErrorMessage(res.status, json) };
    const value = (json as { turivaIncluded?: unknown } | null)?.turivaIncluded;
    // El estado mostrado es el que confirma la API, no el pedido.
    return typeof value === "boolean" ? { ok: true, turivaIncluded: value } : { ok: false, message: TURIVA_SETTING_GENERIC_ERROR };
}

export interface TurivaToggleDeps {
    inFlight: { current: boolean };
    /** Estado confirmado actual (el que se muestra). */
    current: boolean;
    submit: (next: boolean) => Promise<TurivaSettingResult>;
    setLoading: (loading: boolean) => void;
    setError: (message: string) => void;
    setIncluded: (value: boolean) => void;
    setSaved: (saved: boolean) => void;
    refresh: () => void;
}

/**
 * Pide el valor opuesto al confirmado. Con un envío en curso no hace nada.
 * Error: el estado mostrado no cambia (sin optimismo) y se informa el mensaje.
 * Éxito: se fija el valor devuelto por la API y recién entonces se refresca.
 */
export async function runTurivaToggle(d: TurivaToggleDeps): Promise<"skipped" | "saved" | "failed"> {
    if (d.inFlight.current) return "skipped";
    d.inFlight.current = true;
    d.setLoading(true);
    d.setError("");
    d.setSaved(false);
    try {
        const result = await d.submit(!d.current);
        if (!result.ok) {
            d.setError(result.message);
            return "failed";
        }
        d.setIncluded(result.turivaIncluded);
        d.setSaved(true);
        d.refresh();
        return "saved";
    } catch {
        d.setError(TURIVA_SETTING_GENERIC_ERROR);
        return "failed";
    } finally {
        d.inFlight.current = false;
        d.setLoading(false);
    }
}
