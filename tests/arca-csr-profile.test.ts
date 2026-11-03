import { describe, it, expect } from "vitest";
import { CSR_PROFILES, csrSubject, parseAmbiente } from "../scripts/arca/csr-profile.mjs";

const CUIT = "30999999170"; // sintético, DV válido

describe("perfil del CSR por ambiente", () => {
    it("exige un ambiente explícito y único", () => {
        expect(parseAmbiente(["--ambiente=homologacion"])).toBe("homologacion");
        expect(parseAmbiente(["--ambiente=produccion"])).toBe("produccion");
        for (const argv of [[], ["--ambiente=prod"], ["--ambiente=produccion", "--ambiente=homologacion"], ["produccion"]])
            expect(() => parseAmbiente(argv)).toThrow(/--ambiente=/);
    });
    it("CN distinto por ambiente (la compuerta no lo fija: exige el CN declarado en ARCA_WSAA_CERT_CN)", () => {
        expect(csrSubject("homologacion", "ESTUDIO SINTETICO", CUIT)).toBe(`/C=AR/O=ESTUDIO SINTETICO/CN=TaxLiquidator homologacion/serialNumber=CUIT ${CUIT}`);
        expect(csrSubject("produccion", "ESTUDIO SINTETICO", CUIT)).toBe(`/C=AR/O=ESTUDIO SINTETICO/CN=TaxLiquidator produccion/serialNumber=CUIT ${CUIT}`);
        expect(CSR_PROFILES.homologacion.cn).not.toBe(CSR_PROFILES.produccion.cn);
    });
    it("producción pide confirmación escrita, carpeta propia e indica el servicio de ARCA correcto", () => {
        expect(CSR_PROFILES.produccion.confirm).toBe("GENERAR-CSR-PRODUCCION");
        expect(CSR_PROFILES.homologacion.confirm).toBeNull();
        expect(CSR_PROFILES.produccion.dirPrefix).toBe("produccion-");
        expect(CSR_PROFILES.produccion.readme).toContain("Administración de Certificados Digitales");
        expect(CSR_PROFILES.homologacion.readme).toContain("WSASS");
    });
    it("rechaza CUIT o nombre inválidos", () => {
        expect(() => csrSubject("produccion", "ESTUDIO", "30999999171")).toThrow("CUIT");
        expect(() => csrSubject("produccion", "ESTUDIO/CN=otro", CUIT)).toThrow("Nombre");
        expect(() => csrSubject("otro", "ESTUDIO", CUIT)).toThrow("Ambiente");
    });
});
