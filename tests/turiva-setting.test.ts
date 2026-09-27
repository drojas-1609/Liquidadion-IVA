import { describe, it, expect, vi } from "vitest";
import {
  TURIVA_SETTING_BAD_REQUEST_ERROR,
  TURIVA_SETTING_FORBIDDEN_ERROR,
  TURIVA_SETTING_GENERIC_ERROR,
  runTurivaToggle,
  submitTurivaSetting,
  turivaSettingErrorMessage,
  type TurivaSettingResult,
  type TurivaToggleDeps,
} from "@/lib/turiva-setting";
import { PERIOD_NOT_FOUND_ERROR } from "@/lib/period-mutations";

const HAS_VOUCHERS = "El período tiene comprobantes TurIVA (195–197): no se puede desactivar la inclusión en el Régimen TurIVA.";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("submitTurivaSetting", () => {
  it.each([[true], [false]])("PATCH a /api/periods/[id]/vat-settings con el cuerpo exacto { turivaIncluded: %s }", async (value) => {
    const fetchImpl = vi.fn(async () => json(200, { periodId: "p 1", turivaIncluded: value }));
    expect(await submitTurivaSetting("p 1", value, fetchImpl as unknown as typeof fetch)).toEqual({ ok: true, turivaIncluded: value });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/periods/p%201/vat-settings");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ turivaIncluded: value }));
    expect(Object.keys(JSON.parse(init.body as string))).toEqual(["turivaIncluded"]);
  });

  it("el estado confirmado es el que devuelve la API (no el pedido)", async () => {
    const fetchImpl = vi.fn(async () => json(200, { periodId: "p", turivaIncluded: false }));
    expect(await submitTurivaSetting("p", true, fetchImpl as unknown as typeof fetch)).toEqual({ ok: true, turivaIncluded: false });
  });

  it("200 sin booleano en la respuesta -> error genérico (nunca se asume el valor)", async () => {
    const fetchImpl = vi.fn(async () => json(200, { periodId: "p" }));
    expect(await submitTurivaSetting("p", true, fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, message: TURIVA_SETTING_GENERIC_ERROR });
  });

  it("409 al desactivar con comprobantes 195–197 -> mensaje EXACTO de la API", async () => {
    const fetchImpl = vi.fn(async () => json(409, { error: { code: "CONFLICT", message: HAS_VOUCHERS } }));
    expect(await submitTurivaSetting("p", false, fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, message: HAS_VOUCHERS });
  });

  it("error de red -> genérico", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await submitTurivaSetting("p", true, fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, message: TURIVA_SETTING_GENERIC_ERROR });
  });
});

describe("turivaSettingErrorMessage", () => {
  it("400 / 422 / 403 / 404 / 500 -> mensajes claros", () => {
    expect(turivaSettingErrorMessage(400, { error: { code: "BAD_REQUEST", message: "Cuerpo de la solicitud inválido." } })).toBe(TURIVA_SETTING_BAD_REQUEST_ERROR);
    expect(turivaSettingErrorMessage(422, { error: { code: "UNPROCESSABLE_ENTITY", message: "x" }, field: "turivaIncluded" })).toBe(TURIVA_SETTING_BAD_REQUEST_ERROR);
    expect(turivaSettingErrorMessage(403, { error: { code: "FORBIDDEN", message: "x" } })).toBe(TURIVA_SETTING_FORBIDDEN_ERROR);
    expect(turivaSettingErrorMessage(404, { error: { code: "NOT_FOUND", message: "x" } })).toBe(PERIOD_NOT_FOUND_ERROR);
    expect(turivaSettingErrorMessage(500, { error: { code: "INTERNAL", message: "Error interno." } })).toBe(TURIVA_SETTING_GENERIC_ERROR);
  });

  it("409 sin mensaje reconocible -> genérico; ningún cuerpo produce [object Object]", () => {
    expect(turivaSettingErrorMessage(409, null)).toBe(TURIVA_SETTING_GENERIC_ERROR);
    for (const body of [null, "x", 1, { error: {} }, { error: { code: {}, message: {} } }, { error: "texto" }]) {
      for (const status of [400, 403, 404, 409, 422, 500]) {
        expect(turivaSettingErrorMessage(status, body)).not.toMatch(/object Object/);
      }
    }
  });
});

describe("runTurivaToggle — sin optimismo y sin doble envío", () => {
  const deps = (over: Partial<TurivaToggleDeps> = {}) => {
    const calls: string[] = [];
    const d: TurivaToggleDeps = {
      inFlight: { current: false },
      current: false,
      submit: vi.fn(async (next: boolean): Promise<TurivaSettingResult> => ({ ok: true, turivaIncluded: next })),
      setLoading: vi.fn((v: boolean) => calls.push(`loading:${v}`)),
      setError: vi.fn((m: string) => calls.push(`error:${m}`)),
      setIncluded: vi.fn((v: boolean) => calls.push(`included:${v}`)),
      setSaved: vi.fn((v: boolean) => calls.push(`saved:${v}`)),
      refresh: vi.fn(() => calls.push("refresh")),
      ...over,
    };
    return { d, calls };
  };

  it("éxito: pide el valor opuesto, fija el confirmado y refresca DESPUÉS del 200", async () => {
    const { d, calls } = deps();
    expect(await runTurivaToggle(d)).toBe("saved");
    expect(d.submit).toHaveBeenCalledWith(true);
    expect(calls).toEqual(["loading:true", "error:", "saved:false", "included:true", "saved:true", "refresh", "loading:false"]);
    expect(d.inFlight.current).toBe(false);
  });

  it("error (p. ej. 409): el estado mostrado NO cambia, se informa el mensaje y no se refresca", async () => {
    const { d, calls } = deps({
      current: true,
      submit: vi.fn(async (): Promise<TurivaSettingResult> => ({ ok: false, message: HAS_VOUCHERS })),
    });
    expect(await runTurivaToggle(d)).toBe("failed");
    expect(d.submit).toHaveBeenCalledWith(false);
    expect(d.setIncluded).not.toHaveBeenCalled();
    expect(d.refresh).not.toHaveBeenCalled();
    expect(calls).toContain(`error:${HAS_VOUCHERS}`);
    expect(calls.at(-1)).toBe("loading:false");
  });

  it("excepción inesperada del envío -> mensaje genérico, sin cambio de estado", async () => {
    const { d } = deps({ submit: vi.fn(async () => Promise.reject(new Error("boom"))) });
    expect(await runTurivaToggle(d)).toBe("failed");
    expect(d.setError).toHaveBeenLastCalledWith(TURIVA_SETTING_GENERIC_ERROR);
    expect(d.setIncluded).not.toHaveBeenCalled();
    expect(d.inFlight.current).toBe(false);
  });

  it("doble envío: con un PATCH en curso, un segundo toggle no envía nada", async () => {
    let resolve!: (r: TurivaSettingResult) => void;
    const submit = vi.fn(() => new Promise<TurivaSettingResult>((r) => (resolve = r)));
    const { d } = deps({ submit });
    const first = runTurivaToggle(d);
    expect(await runTurivaToggle(d)).toBe("skipped");
    expect(await runTurivaToggle(d)).toBe("skipped");
    expect(submit).toHaveBeenCalledTimes(1);
    resolve({ ok: true, turivaIncluded: true });
    expect(await first).toBe("saved");
    // Terminado el primero, se puede volver a enviar.
    expect(await runTurivaToggle({ ...d, submit: vi.fn(async () => ({ ok: true, turivaIncluded: false }) as TurivaSettingResult) })).toBe("saved");
  });
});
