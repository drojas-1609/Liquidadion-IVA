import { describe, it, expect } from "vitest";
import { ConstanciaParseError, parseConstancia } from "@/lib/arca-constancia/parse";
import { isEmptyProposal, proposeFromConstancia } from "@/lib/arca-constancia/apply";
import { backupFileName, backupFolderPath, MANUAL_BACKUP_CATEGORIES } from "@/lib/drive/naming";

// Constancia ficticia (datos inventados), con el mismo orden de texto que entrega el PDF de ARCA.
const CM = `EMPRESA DE PRUEBA S. A. S. CUIT: 30-00000000-0
AV. SIEMPRE VIVA 742
9405-EL CALAFATE - SANTA CRUZ
CALLE FALSA 123 Piso:2 Dpto:B
1043-CIUDAD AUTONOMA BUENOS AIRES
CONSTANCIA DE INSCRIPCION
IMPUESTOS/REGIMENES NACIONALES REGISTRADOS Y FECHA DE ALTA
GANANCIAS SOCIEDADES 01-2024
IVA 01-2024
REG. SEG. SOCIAL EMPLEADOR 03-2024
****************************************************
Contribuyente no amparado en los beneficios promocionales INDUSTRIALES establecidos por Ley 22021 y sus modificatorias 22702 y 22973, a la
fecha de emision de la presente constancia.
Esta constancia no da cuenta de la inscripción en:
- Aporte Solidario: de corresponder, deberá solicitarse en la dependencia donde se encuentra inscripto.
ACTIVIDADES NACIONALES REGISTRADAS Y FECHA DE ALTA
Actividad principal: 551021 (F-883) SERVICIOS DE ALOJAMIENTO EN HOTELES DE CUATRO Y CINCO ESTRELLAS Mes de inicio: 01/2024
Secundaria(s): 561011 (F-883) SERVICIOS DE RESTAURANTES Y CANTINAS SIN
ESPECTÁCULO
Mes de inicio: 02/2024
Mes de cierre ejercicio comercial: 12
DOMICILIO FISCAL - ARCA
IMPUESTOS PROVINCIALES - FECHA DE ALTA
IIBB CONVENIO MULTILATERAL - ACTIVO 01/2024
JURISDICCIONES ADHERIDAS - FECHA DE ALTA
901 CIUDAD AUTONOMA BUENOS AIRES desde: 01/2024
902 BUENOS AIRES desde: 05/2025
920 SANTA CRUZ desde: 01/2024
ACTIVIDADES PROVINCIALES REGISTRADAS Y FECHA DE ALTA
Actividad principal: 551021 NAES Servicios de alojamiento en hoteles de cuatro y cinco estrellas Art: 2 desde: 01/2024
Secundaria(s): 561011 NAES Servicios de restaurantes y cantinas sin espectáculo Art: 2 desde: 02/2024
DOMICILIO FISCAL - JURISDICCIONAL / SEDE
Vigencia de la presente constancia: 20-11-2026 a 20-12-2026 Hora 10:15:00 Verificador 100000000001
Los datos contenidos en la presente constancia deberán ser validados por el receptor de la misma en la página institucional de ARCA http://www.arca.gob.ar.`;

describe("constancia de inscripción ARCA", () => {
  it("lee encabezado, vigencia, impuestos y actividades nacionales", () => {
    const c = parseConstancia(CM);
    expect(c).toMatchObject({ cuit: "30-00000000-0", name: "EMPRESA DE PRUEBA S. A. S.", issuedOn: "2026-11-20", validUntil: "2026-12-20", verifier: "100000000001", closingMonth: 12 });
    expect(c.fiscalAddress).toBe("AV. SIEMPRE VIVA 742, 9405-EL CALAFATE - SANTA CRUZ");
    expect(c.nationalTaxes.map((t) => [t.name, t.since])).toEqual([["GANANCIAS SOCIEDADES", "2024-01"], ["IVA", "2024-01"], ["REG. SEG. SOCIAL EMPLEADOR", "2024-03"]]);
    expect(c.nationalActivities).toEqual([
      { code: "551021", description: "SERVICIOS DE ALOJAMIENTO EN HOTELES DE CUATRO Y CINCO ESTRELLAS", since: "2024-01", principal: true, article: null },
      { code: "561011", description: "SERVICIOS DE RESTAURANTES Y CANTINAS SIN ESPECTÁCULO", since: "2024-02", principal: false, article: null },
    ]);
  });

  it("lee IIBB: Convenio Multilateral, jurisdicciones, sede y actividades NAES con artículo", () => {
    const c = parseConstancia(CM);
    expect(c.iibb).toEqual({ raw: "IIBB CONVENIO MULTILATERAL - ACTIVO", regime: "CONVENIO_MULTILATERAL", active: true, since: "2024-01" });
    expect(c.jurisdictions.map((j) => j.code)).toEqual(["901", "902", "920"]);
    // Sede: CABA (y no «Buenos Aires», que también está contenido en el nombre).
    expect(c.headquartersCode).toBe("901");
    expect(c.provincialActivities).toEqual([
      { code: "551021", description: "Servicios de alojamiento en hoteles de cuatro y cinco estrellas", since: "2024-01", principal: true, article: "2" },
      { code: "561011", description: "Servicios de restaurantes y cantinas sin espectáculo", since: "2024-02", principal: false, article: "2" },
    ]);
  });

  it("sin bloque provincial no inventa inscripción; rechaza lo que no es una constancia", () => {
    const local = CM.split("\n").filter((l) => !/IIBB|^9\d\d |NAES|ACTIVIDADES PROVINCIALES|JURISDICCIONES ADHERIDAS|IMPUESTOS PROVINCIALES/.test(l)).join("\n");
    const c = parseConstancia(local);
    expect(c.iibb).toBeNull();
    expect(c.jurisdictions).toEqual([]);
    expect(c.headquartersCode).toBeNull();
    expect(() => parseConstancia("FACTURA A\nCUIT: 30-00000000-0")).toThrow(ConstanciaParseError);
    expect(() => parseConstancia("CONSTANCIA DE INSCRIPCION\nsin cuit")).toThrow(/CUIT/);
  });

  it("propone sólo agregados y avisa lo que está en la ficha y no en la constancia", () => {
    const c = parseConstancia(CM);
    const p = proposeFromConstancia(c, {
      registration: "LOCAL",
      jurisdictions: [{ code: "920", headquarters: false }, { code: "905", headquarters: false }],
      activities: [{ nomenclator: "NAES", code: "561011" }, { nomenclator: "NAES", code: "692000" }, { nomenclator: "ARCA", code: "551021" }],
    });
    expect(p.registration).toBe("CONVENIO_MULTILATERAL");
    expect(p.addJurisdictions.map((j) => j.code)).toEqual(["901", "902"]);
    expect(p.headquarters).toBe("901");
    expect(p.addActivities.map((a) => a.code)).toEqual(["551021"]);
    expect(p.onlyInFormJurisdictions).toEqual(["905"]);
    expect(p.onlyInFormActivities).toEqual(["692000"]);
    const same = proposeFromConstancia(c, {
      registration: "CONVENIO_MULTILATERAL",
      jurisdictions: [{ code: "901", headquarters: true }, { code: "902", headquarters: false }, { code: "920", headquarters: false }],
      activities: [{ nomenclator: "NAES", code: "551021" }, { nomenclator: "NAES", code: "561011" }],
    });
    expect(isEmptyProposal(same)).toBe(true);
  });

  it("en Drive va a CONSTANCIAS con nombre fijo (se reemplaza) y no se carga a mano desde Respaldos", () => {
    const t = { category: "CONSTANCIAS" as const, client: { name: "Empresa de Prueba S. A. S.", cuit: "30000000000" }, year: 2026, description: "CONSTANCIA DE INSCRIPCION", extension: "pdf" };
    expect(backupFolderPath(t).slice(1)).toEqual(["CONSTANCIAS"]);
    expect(backupFileName(t)).not.toMatch(/2026/);
    expect(backupFileName(t)).toMatch(/^CONSTANCIA DE INSCRIPCION .*\.pdf$/);
    expect(MANUAL_BACKUP_CATEGORIES).not.toContain("CONSTANCIAS");
  });
});

describe("constancia de un inscripto local con formulario provincial (datos ficticios)", () => {
  const LONG = "Actividades y/o servicios de intermediación que se ejerzan percibiendo comisiones, bonificaciones, porcentajes u otras retribuciones análogas N.C.P. (Incluye venta de combustibles al por menor por comisión, venta de mercaderías de propiedad de terceros, servicios de agencias de viajes, comisión por venta de automotores, etc.) y otras actividades de prueba para superar el máximo";
  const LOCAL = `PERSONA DE PRUEBA CUIT: 20-00000000-1
CALLE 1 123
9400-RIO GALLEGOS - SANTA CRUZ
CALLE 1 123
9400-RIO GALLEGOS - SANTA CRUZ
CONSTANCIA DE INSCRIPCION
IMPUESTOS/REGIMENES NACIONALES REGISTRADOS Y FECHA DE ALTA
IVA 01-2024
ACTIVIDADES NACIONALES REGISTRADAS Y FECHA DE ALTA
Actividad principal: 492120 (F-883) SERVICIOS DE TRANSPORTE DE PRUEBA Mes de inicio: 01/2024
DOMICILIO FISCAL - ARCA
IMPUESTOS PROVINCIALES - FECHA DE ALTA
IIBB LOCAL SANTA CRUZ - ACTIVO 08/2023
JURISDICCIONES ADHERIDAS - FECHA DE ALTA
920 SANTA CRUZ desde: 08/2023
ACTIVIDADES PROVINCIALES REGISTRADAS Y FECHA DE ALTA
Actividad principal: 492120 (F-920) Servicios de transporte de prueba desde: 08/2023
Secundaria(s): 960999 (F-920) ${LONG} desde: 08/2023
Secundaria(s): 562010 (F-920) Servicios de preparación de comidas para empresas desde: 08/2023
DOMICILIO FISCAL - JURISDICCIONAL
CALLE 1 123
Vigencia de la presente constancia: 20-11-2026 a 20-12-2026 Hora 10:15:00 Verificador 100000000002`;
  it("quita «(F-920)», no pega el encabezado siguiente y recorta descripciones largas al proponer", () => {
    const c = parseConstancia(LOCAL);
    expect(c.provincialActivities.map((a) => a.code)).toEqual(["492120", "960999", "562010"]);
    expect(c.provincialActivities[0].description).toBe("Servicios de transporte de prueba");
    expect(c.provincialActivities[2].description).toBe("Servicios de preparación de comidas para empresas");
    const p = proposeFromConstancia(c, { registration: null, jurisdictions: [], activities: [] } as never);
    const long = p.addActivities.find((a) => a.code === "960999")!;
    expect(long.description.length).toBeLessThanOrEqual(300);
    expect(long.description.endsWith("…")).toBe(true);
    expect(long.description.startsWith("Actividades y/o servicios de intermediación")).toBe(true);
  });
});
