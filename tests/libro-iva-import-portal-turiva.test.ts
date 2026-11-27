import { describe, it, expect } from "vitest";
import { parsePortalDownload, PORTAL_HEADERS, PORTAL_TURIVA_HEADERS } from "@/lib/libro-iva-import/portal-csv";
import { buildImportPreview, type PreviewContext } from "@/lib/libro-iva-import/build";

// Datos FICTICIOS con la forma de la descarga de ventas de la pestaña TurIVA de Portal IVA
// (observada el 27/11/2026): «Importe Total» = neto + IVA − reintegro.
const H = PORTAL_TURIVA_HEADERS.SALES!;
function csv(rows: Array<Record<string, string>>): Uint8Array {
    const line = (r: Record<string, string>) => H.map((h) => r[h] ?? "").join(";");
    const text = [H.map((h) => `"${h}"`).join(";"), ...rows.map(line)].join("\r\n") + "\r\n";
    return new Uint8Array(Buffer.from(text, "latin1"));
}
const row = (over: Record<string, string> = {}) => ({
    "Fecha de Emisión": "2026-10-19", "Tipo de Comprobante": "195", "Punto de Venta": "7", "Número de Comprobante": "129", "Número de Comprobante Hasta": "129",
    "Tipo Doc. Comprador": "94", "Nro. Doc. Comprador": "", "Denominación Comprador": "TURISTA FICTICIO", "Importe Total": "750000,00", "Moneda Original": "PES", "Tipo de Cambio": "1,00",
    "Importe No Gravado": "0,00", "Importe Exento": "0,00", "Importe Reintegro Decreto 1043/2016 (TurIVA)": "157500,00",
    "Neto Gravado IVA 21%": "750000,00", "Importe IVA 21%": "157500,00", "Total Neto Gravado": "750000,00", "Total IVA": "157500,00", ...over,
});
const ctx = (turivaIncluded: boolean): PreviewContext => ({
    category: "SALES", period: { month: 10, year: 2026 }, settings: { creditProrationMode: "NONE", globalCoefficient: null, turivaIncluded },
    existingKeys: new Set(), source: "PORTAL_CSV",
});
function preview(bytes: Uint8Array, included = true) {
    const p = parsePortalDownload(bytes, "SALES");
    return { parsed: p, preview: buildImportPreview(ctx(included), p.vouchers, p.aliquots, { fileErrors: p.fileErrors, rowNotes: p.totalColumnNotes }) };
}

describe("descarga TurIVA de ventas de Portal IVA", () => {
    it("el encabezado es el general más el reintegro después de «Importe Otros Tributos»", () => {
        expect(H.length).toBe(PORTAL_HEADERS.SALES.length + 1);
        expect(H[H.indexOf("Importe Otros Tributos") + 1]).toBe("Importe Reintegro Decreto 1043/2016 (TurIVA)");
    });
    it("factura T: va a la pestaña TURIVA con total = neto + IVA y el reintegro aparte", () => {
        const { parsed, preview: p } = preview(csv([row()]));
        expect(parsed.fileErrors).toEqual([]);
        expect(parsed.vouchers.turiva).toBe(true);
        expect(p.rows.map((r) => r.status)).toEqual(["OK"]);
        const mdl = p.rows[0].model!;
        expect(mdl.lidSection).toBe("TURIVA");
        expect([mdl.voucherTotalAmount.toFixed(2), mdl.turivaRefundAmount.toFixed(2), mdl.totalVatAmount.toFixed(2)]).toEqual(["907500.00", "157500.00", "157500.00"]);
        expect(p.rows[0].notes.join(" ")).toMatch(/neto del reintegro/);
        expect(p.reconciliation.importable.TURIVA.turivaRefund.toFixed(2)).toBe("157500.00");
    });
    it("redondeo de un centavo de ARCA: queda para revisar (se acepta con el ajuste de redondeo)", () => {
        const { preview: p } = preview(csv([row({ "Importe Total": "4664649,30", "Importe Reintegro Decreto 1043/2016 (TurIVA)": "979576,35", "Neto Gravado IVA 21%": "4664649,29", "Importe IVA 21%": "979576,35", "Total Neto Gravado": "4664649,29", "Total IVA": "979576,40" })]));
        expect(p.rows[0].status).toBe("REVIEW");
        expect(p.rows[0].messages.join(" ")).toMatch(/diferencia 0\.01/);
    });
    it("período no incluido en TurIVA: error con el motivo; un comprobante general en el archivo TurIVA es error", () => {
        expect(preview(csv([row()]), false).preview.rows[0].messages.join(" ")).toMatch(/no está incluido en el Régimen TurIVA/);
        const p = preview(csv([row({ "Tipo de Comprobante": "6", "Importe Reintegro Decreto 1043/2016 (TurIVA)": "0,00", "Importe Total": "907500,00" })])).preview;
        expect(p.rows[0].status).toBe("ERROR");
        expect(p.rows[0].messages.join(" ")).toMatch(/sólo admite comprobantes clase T/);
    });
});

describe("descarga TurIVA: redondeo aceptado", () => {
    it("con la corrección de redondeo, la diferencia de un centavo se importa con nota", () => {
        const p = parsePortalDownload(csv([row({ "Importe Total": "4664649,30", "Importe Reintegro Decreto 1043/2016 (TurIVA)": "979576,35", "Neto Gravado IVA 21%": "4664649,29", "Importe IVA 21%": "979576,35", "Total Neto Gravado": "4664649,29", "Total IVA": "979576,35" })]), "SALES");
        const pv = buildImportPreview({ ...ctx(true), corrections: { acceptRounding: true } }, p.vouchers, p.aliquots, { fileErrors: p.fileErrors, rowNotes: p.totalColumnNotes });
        expect(pv.rows[0].status).toBe("OK");
        expect(pv.rows[0].notes.join(" ")).toMatch(/diferencia de redondeo aceptada/);
    });
});

describe("descarga de Portal IVA en otra moneda", () => {
    it("DOL con tipo de cambio: se importa con nota (los importes ya están en pesos); sin tipo de cambio sigue para revisar", () => {
        const dol = row({ "Moneda Original": "DOL", "Tipo de Cambio": "1534,00" });
        const ok = preview(csv([dol])).preview.rows[0];
        expect(ok.status).toBe("OK");
        expect(ok.notes.join(" ")).toMatch(/moneda original DOL con tipo de cambio 1534/);
        expect(ok.model!.currencyCode).toBe("PES");
        expect(preview(csv([row({ "Moneda Original": "DOL", "Tipo de Cambio": "0,00" })])).preview.rows[0].status).toBe("REVIEW");
    });
});

describe("detección de la diferencia de redondeo en la vista previa", () => {
    it("reconoce el mensaje real de build.ts (con el importe calculado entre medio)", async () => {
        const { hasRoundingDifference } = await import("@/lib/libro-iva-import/rounding");
        const p = parsePortalDownload(csv([row({ "Importe Total": "4664649,30", "Importe Reintegro Decreto 1043/2016 (TurIVA)": "979576,35", "Neto Gravado IVA 21%": "4664649,29", "Importe IVA 21%": "979576,35", "Total Neto Gravado": "4664649,29", "Total IVA": "979576,35" })]), "SALES");
        const pv = buildImportPreview(ctx(true), p.vouchers, p.aliquots, { fileErrors: p.fileErrors, rowNotes: p.totalColumnNotes });
        expect(hasRoundingDifference(pv.rows[0].messages)).toBe(true);
        expect(hasRoundingDifference(["el total informado 100.00 no coincide con la suma de sus componentes 99.00 (diferencia 1.00)"])).toBe(false);
    });
});
