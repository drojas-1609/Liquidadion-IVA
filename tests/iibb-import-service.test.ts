import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { Prisma } from "@prisma/client";
import { cuitCheckDigit } from "@/lib/cuit";
import { buildIibbImportPreview } from "@/lib/iibb-import/service";
import { parseIibbDeductions } from "@/lib/iibb-import/formats";

// Datos sintéticos.
const AGENT = "3099999999" + String(cuitCheckDigit("3099999999"));
const left = (v: string, n: number) => v.padStart(n, " ");
const ret = (fecha: string, nro: string, imp: string) => AGENT + fecha + nro + left("1000.00", 16) + left(imp, 16);
const enc = (s: string) => new TextEncoder().encode(s);
const OCT = { month: 10, year: 2026 };

describe("vista previa de deducciones de IIBB", () => {
    it("OK dentro del período; fuera del período queda para revisar", () => {
        const p = buildIibbImportPreview(enc(`${ret("20261027", "00000001", "10.00")}\n${ret("20261103", "00000002", "20.00")}\n`), OCT, new Map(), "p1");
        expect(p.format).toBe("ESICOL_RETENCIONES");
        expect(p.jurisdictionCode).toBe("901");
        expect(p.rows.map((r) => r.status)).toEqual(["OK", "REVIEW"]);
        expect(p.importableTotal).toBe("10.00");
        expect(p.excludedTotal).toBe("20.00");
    });

    it("ya registrada para el cliente con el mismo importe: se omite; con otro importe: revisar", () => {
        const file = enc(`${ret("20261027", "00000001", "10.00")}\n${ret("20261027", "00000002", "20.00")}\n`);
        const ids = parseIibbDeductions(file).rows.map((r) => `901|${r.identity}`);
        const existing = new Map([
            [ids[0], { amount: new Prisma.Decimal("10.00"), period: "10/2026" }],
            [ids[1], { amount: new Prisma.Decimal("25.00"), period: "09/2026" }],
        ]);
        const p = buildIibbImportPreview(file, OCT, existing, "p1");
        expect(p.rows.map((r) => r.status)).toEqual(["DUPLICATE", "REVIEW"]);
        expect(p.rows[1].messages.join(" ")).toMatch(/09\/2026 con otro importe \(25.00\)/);
        expect(p.counts).toEqual({ OK: 0, DUPLICATE: 1, REVIEW: 1, ERROR: 0 });
    });

    it("repetida dentro del archivo: ERROR", () => {
        const line = ret("20261027", "00000001", "10.00");
        expect(buildIibbImportPreview(enc(`${line}\n${line}\n`), OCT, new Map(), "p1").rows.map((r) => r.status)).toEqual(["OK", "ERROR"]);
    });

    it("el token cambia si cambia el período o lo registrado", () => {
        const file = enc(ret("20261027", "00000001", "10.00"));
        const a = buildIibbImportPreview(file, OCT, new Map(), "p1").token;
        expect(buildIibbImportPreview(file, OCT, new Map(), "p2").token).not.toBe(a);
        const id = `901|${parseIibbDeductions(file).rows[0].identity}`;
        expect(buildIibbImportPreview(file, OCT, new Map([[id, { amount: new Prisma.Decimal("10.00"), period: "10/2026" }]]), "p1").token).not.toBe(a);
    });
});
