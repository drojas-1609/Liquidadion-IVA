import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// La percepción de IIBB tomada de una compra se vincula a ella: la restricción
// TaxRecord_f2051_detail_check debe admitir invoiceId con type 'PERCEPCION IIBB'
// (antes sólo percepción de IVA; el alta fallaba con «Error interno»).
const sql = readFileSync("prisma/migrations/20261118130000_tax_record_iibb_invoice_link/migration.sql", "utf8");

describe("migración: vínculo de la percepción de IIBB con su compra", () => {
    it("recrea la restricción con la ampliación para IIBB y la valida", () => {
        expect(sql).toContain('DROP CONSTRAINT "TaxRecord_f2051_detail_check"');
        expect(sql).toContain(`("invoiceId" IS NULL OR "nature" = 'PERCEPTION' OR "type" = 'PERCEPCION IIBB')`);
        expect(sql).toContain('VALIDATE CONSTRAINT "TaxRecord_f2051_detail_check"');
    });
    it("conserva las demás condiciones del F.2051", () => {
        for (const line of [
            `("agentCuit" IS NULL OR "agentCuit" ~ '^[0-9]{11}$')`,
            `("taxCode" IS NULL OR "taxCode" IN (767, 216))`,
            `("nature" IS NULL OR "type" IN ('RETENCION IVA', 'PERCEPCION IVA'))`,
            `("nature" IS DISTINCT FROM 'RETENTION' OR "type" = 'RETENCION IVA')`,
        ]) expect(sql).toContain(line);
    });
});
