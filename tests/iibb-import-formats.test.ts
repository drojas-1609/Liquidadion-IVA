import { describe, expect, it } from "vitest";
import { cuitCheckDigit } from "@/lib/cuit";
import { parseIibbDeductions } from "@/lib/iibb-import/formats";

// Datos sintéticos: CUIT de prueba con dígito verificador válido y CBU ficticios.
const cuit = (first10: string) => first10 + String(cuitCheckDigit(first10));
const AGENT = cuit("3099999999"); // agente de percepción/retención
const BANK = cuit("3088888888"); // banco
const CBU = "0110000100000000000001";
const enc = (s: string) => new TextEncoder().encode(s);
const latin1 = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const left = (v: string, n: number) => v.padStart(n, " ");

/** Percepción e-SICOL (65): CUIT · número (8) · fecha · sucursal (4) · base (16) · importe (16) · tipo · letra. */
const esicolPerc = (o: { nro?: string; fecha?: string; suc?: string; base?: string; imp?: string; tipo?: string; letra?: string; cuit?: string } = {}) =>
    (o.cuit ?? AGENT) + (o.nro ?? "00001234") + (o.fecha ?? "20261021") + (o.suc ?? "0000") + left(o.base ?? "1000.00", 16) + left(o.imp ?? "50.00", 16) + (o.tipo ?? "F") + (o.letra ?? "T");
/** Retención e-SICOL (59): CUIT · fecha · constancia (8) · base (16) · importe (16). */
const esicolRet = (o: { fecha?: string; nro?: string; imp?: string } = {}) => AGENT + (o.fecha ?? "20261027") + (o.nro ?? "00075907") + left("7926.00", 16) + left(o.imp ?? "317.04", 16);
/** Bancaria e-SICOL (63): CUIT banco · fecha · importe (16) · 6 sin documentar · CBU. */
const esicolBanc = (o: { imp?: string; cbu?: string } = {}) => BANK + "20261015" + left(o.imp ?? "151.36", 16) + "511002" + (o.cbu ?? CBU);

describe("e-SICOL (AGIP): diseño publicado", () => {
    it("percepción: lee cada campo y la jurisdicción 901", () => {
        const p = parseIibbDeductions(enc(`${esicolPerc()}\n`));
        expect(p.format).toBe("ESICOL_PERCEPCIONES");
        const [r] = p.rows;
        expect(r).toMatchObject({
            status: "OK", type: "PERCEPCION IIBB", jurisdictionCode: "901", agentCuit: AGENT, date: "2026-10-21",
            voucherNumber: "00001234", pointOfSale: "0000", voucherKind: "F", voucherLetter: "T",
        });
        expect(r.baseAmount!.toFixed(2)).toBe("1000.00");
        expect(r.amount!.toFixed(2)).toBe("50.00");
    });

    it("nota de crédito (tipo C): el importe resta", () => {
        const [r] = parseIibbDeductions(enc(esicolPerc({ tipo: "C", letra: "A" }))).rows;
        expect(r.amount!.toFixed(2)).toBe("-50.00");
    });

    it("errores con motivo: CUIT, fecha, tipo y letra fuera de tabla", () => {
        const [r] = parseIibbDeductions(enc(esicolPerc({ cuit: "30999999990", fecha: "20261340", tipo: "X", letra: "Z" }))).rows;
        expect(r.status).toBe("ERROR");
        expect(r.messages.join(" | ")).toMatch(/CUIT del agente inválido.*fecha inválida.*tipo de comprobante «X».*letra «Z»/);
    });

    it("retención: CUIT · fecha · constancia · base · importe", () => {
        const p = parseIibbDeductions(enc(`${esicolRet()}\r\n${esicolRet({ nro: "00075908", imp: "1016.17" })}\r\n`));
        expect(p.format).toBe("ESICOL_RETENCIONES");
        expect(p.rows.map((r) => [r.type, r.date, r.certificateNumber, r.amount!.toFixed(2)])).toEqual([
            ["RETENCION IIBB", "2026-10-27", "00075907", "317.04"],
            ["RETENCION IIBB", "2026-10-27", "00075908", "1016.17"],
        ]);
    });

    it("bancaria: conserva el CBU y los 6 caracteres sin documentar tal cual", () => {
        const [r] = parseIibbDeductions(enc(esicolBanc())).rows;
        expect(r).toMatchObject({ status: "OK", type: "SIRCREB", agentCuit: BANK, date: "2026-10-15", cbu: CBU, rawBankExtra: "511002" });
        expect(r.amount!.toFixed(2)).toBe("151.36");
    });

    it("CBU que no tiene 22 dígitos: ERROR", () => {
        const line = esicolBanc().slice(0, 41) + "01100001000000000000AB";
        expect(parseIibbDeductions(enc(line)).rows[0].status).toBe("ERROR");
    });
});

describe("Rentas Ciudad (AGIP): CSV «.xls» en Latin-1", () => {
    const HEAD_RET = "CUIT,N° Ader,Razon Social,N° Certificado,Norma,Fecha Retencion,Tipo Comprobante,N° Comprobante,Fecha Comprobante,Monto Retenido,Base Calculo";
    const HEAD_PERC = "CUIT,N° Ader,Razon Social,N° Certificado,Norma,Fecha Percepcion,Tipo Comprobante,N° Comprobante,Fecha Comprobante,Monto Percibido,Base Calculo";
    const HEAD_BANC = "cuit,razonSocial,fechaPresentacion,importeCR,importeRecaudado,coeficienteJurisdiccion,importeRecaudadoPorJuris,tipoCuenta,CBU";

    it("retenciones: misma identidad que la línea de e-SICOL (no duplica si se importan los dos)", () => {
        const csv = `sep=,\r\n\r\n${HEAD_RET}\r\n"${AGENT}","1","AGENTE PRUEBA SA","0000000000000000","28","27/10/2026","X","38606000075907","27/10/2026","317.04","7926.00",\r\n`;
        const a = parseIibbDeductions(latin1(csv));
        expect(a.format).toBe("RENTAS_CIUDAD_RETENCIONES");
        expect(a.rows[0]).toMatchObject({ status: "OK", agentName: "AGENTE PRUEBA SA", certificateNumber: null, date: "2026-10-27" });
        expect(a.rows[0].identity).toBe(parseIibbDeductions(enc(esicolRet())).rows[0].identity);
    });

    it("percepciones: separa la letra del número y coincide con e-SICOL aunque éste diga «T»", () => {
        const csv = `sep=,\r\n\r\n${HEAD_PERC}\r\n"${AGENT}","2","AGENTE PRUEBA SA","0000000000000000","29","21/10/2026","F","A0   4170000001234","21/10/2026","50.00","1000.00",\r\n`;
        const [r] = parseIibbDeductions(latin1(csv)).rows;
        expect(r).toMatchObject({ status: "OK", voucherKind: "F", voucherLetter: "A", voucherNumber: "04170000001234" });
        expect(r.identity).toBe(parseIibbDeductions(enc(esicolPerc())).rows[0].identity);
    });

    it("bancarias: toma el importe atribuido a la jurisdicción; coeficiente distinto de 1 queda para revisar", () => {
        const csv = `sep=,\r\n\r\n${HEAD_BANC}\r\n"${BANK}","BANCO PRUEBA","15/10/2026","7568","151.36","1","151.36","2","${CBU}",\r\n"${BANK}","BANCO PRUEBA","16/10/2026","7568","151.36","0.5","75.68","2","${CBU}",\r\n`;
        const p = parseIibbDeductions(latin1(csv));
        expect(p.format).toBe("RENTAS_CIUDAD_BANCARIAS");
        expect(p.rows.map((r) => [r.status, r.amount!.toFixed(2)])).toEqual([["OK", "151.36"], ["REVIEW", "75.68"]]);
        expect(p.rows[0].identity).toBe(parseIibbDeductions(enc(esicolBanc())).rows[0].identity);
    });

    it("columnas no reconocidas: error de archivo, sin filas", () => {
        const p = parseIibbDeductions(latin1(`sep=,\r\n\r\nCUIT,Otra,Cosa\r\n"1","2","3",\r\n`));
        expect(p).toMatchObject({ format: null, rows: [] });
        expect(p.fileErrors[0]).toMatch(/no reconocidas/);
    });
});

describe("Santa Cruz: descarga «retenciones-percepciones-diu.zip»", () => {
    it("retenciones: fecha · CUIT · constancia (15) · importe con coma; jurisdicción 920", () => {
        const p = parseIibbDeductions(enc(`15/10/2026${AGENT}000182751860334000000000450,00\r\n`));
        expect(p.format).toBe("SANTA_CRUZ_RETENCIONES");
        expect(p.rows[0]).toMatchObject({ status: "OK", jurisdictionCode: "920", type: "RETENCION IIBB", date: "2026-10-15", certificateNumber: "000182751860334" });
        expect(p.rows[0].amount!.toFixed(2)).toBe("450.00");
    });

    it("bancarias: sólo período, se registra al último día y lo avisa; repetidas se numeran", () => {
        const line = `202610${CBU}000000024157,65`;
        const p = parseIibbDeductions(enc(`${line}\r\n${line}`));
        expect(p.format).toBe("SANTA_CRUZ_BANCARIAS");
        expect(p.rows.map((r) => [r.date, r.cbu, r.amount!.toFixed(2)])).toEqual([["2026-10-31", CBU, "24157.65"], ["2026-10-31", CBU, "24157.65"]]);
        expect(p.rows[0].messages[0]).toMatch(/último día del mes/);
        expect(new Set(p.rows.map((r) => r.identity)).size).toBe(2);
    });
});

describe("Santa Cruz: percepciones (53 caracteres, diseño de importación del F.5680)", () => {
    const AGENT2 = cuit("3077777777");
    it("variante codificada: letra 1=A, tipo 1=Factura / 3=Nota de crédito, número PPPP-NNNNNNNN", () => {
        const p = parseIibbDeductions(enc([
            `13/10/2026${AGENT}110015-00345804  000000000282,63`,
            `30/10/2026${AGENT}130015-00015790  -00000000525,62`,
        ].join("\r\n") + "\r\n"));
        expect(p.format).toBe("SANTA_CRUZ_PERCEPCIONES");
        expect(p.rows.map((r) => [r.status, r.voucherLetter, r.voucherKind, r.pointOfSale, r.voucherNumber, r.amount!.toFixed(2), r.jurisdictionCode]))
            .toEqual([["OK", "A", "F", "0015", "00345804", "282.63", "920"], ["OK", "A", "C", "0015", "00015790", "-525.62", "920"]]);
    });

    it("variante de la descarga de ASIP: tipo/letra como texto, sin número; signo dentro del campo", () => {
        const p = parseIibbDeductions(enc([
            `30/10/2026${AGENT}6A00000000000001500000000-525,62`,
            `06/10/2026${AGENT}1A000000000000015000000011341,55`,
            `30/10/2026${AGENT2}F 00000000000A360000000001550,10`,
        ].join("\r\n")));
        expect(p.format).toBe("SANTA_CRUZ_PERCEPCIONES");
        expect(p.rows.map((r) => [r.status, r.voucherKind, r.voucherLetter, r.voucherNumber, r.amount!.toFixed(2)]))
            .toEqual([["OK", "C", "A", null, "-525.62"], ["OK", "F", "A", null, "11341.55"], ["OK", "F", null, null, "1550.10"]]);
        expect(p.rows[0].messages.join(" ")).toMatch(/no trae el número/);
    });

    it("las dos variantes comparten identidad (importar ambas no duplica)", () => {
        const a = parseIibbDeductions(enc(`06/10/2026${AGENT}1A000000000000015000000011341,55`)).rows[0];
        const b = parseIibbDeductions(enc(`06/10/2026${AGENT}110015-00344985  000000011341,55`)).rows[0];
        expect(a.identity).toBe(b.identity);
    });

    it("signo incoherente con el tipo o tipo desconocido: ERROR con motivo", () => {
        const rows = parseIibbDeductions(enc([
            `06/10/2026${AGENT}130015-00344985  000000011341,55`,
            `06/10/2026${AGENT}9A000000000000015000000011341,55`,
        ].join("\n"))).rows;
        expect(rows[0].status).toBe("ERROR");
        expect(rows[0].messages.join(" ")).toMatch(/signo/);
        expect(rows[1].status).toBe("ERROR");
        expect(rows[1].messages.join(" ")).toMatch(/tipo de comprobante «9»/);
    });
});

describe("detección", () => {
    it("archivo vacío o de largo desconocido: error de archivo", () => {
        expect(parseIibbDeductions(enc("\n\n")).fileErrors).toEqual(["el archivo está vacío"]);
        expect(parseIibbDeductions(enc("12345\n")).fileErrors[0]).toMatch(/no reconocido/);
    });
    it("registros de distinto largo: no se adivina", () => {
        expect(parseIibbDeductions(enc(`${esicolPerc()}\n${esicolRet()}\n`)).fileErrors[0]).toMatch(/mismo largo/);
    });
});
