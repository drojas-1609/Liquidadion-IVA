import { describe, expect, it } from "vitest";
import { backupFileName, backupFolderPath, cleanSegment, clientFolderName, guessExtension, qEscape, withSuffix } from "@/lib/drive/naming";

const client = { name: "Empresa Ejemplo S.A.S.", cuit: "30-71234567-1" };

describe("respaldo en Drive — carpetas y nombres", () => {
    it("carpeta del cliente: RAZÓN SOCIAL - CUIT", () => {
        expect(clientFolderName(client.name, client.cuit)).toBe("EMPRESA EJEMPLO S.A.S. - 30712345671");
    });
    it("IVA compras va a IVA/AAAA/AAAA MM/COMPRAS", () => {
        const t = { category: "IVA_COMPRAS" as const, client, month: 10, year: 2026, description: "Libro IVA Digital compras comprobantes", extension: "txt" };
        expect(backupFolderPath(t)).toEqual(["EMPRESA EJEMPLO S.A.S. - 30712345671", "IVA", "2026", "2026 10", "COMPRAS"]);
        expect(backupFileName(t)).toBe("2026 10 LIBRO IVA DIGITAL COMPRAS COMPROBANTES EMPRESA EJEMPLO S.A.S..txt");
    });
    it("IIBB retenciones y percepciones", () => {
        expect(backupFolderPath({ category: "IIBB_RET_PERC", client, month: 1, year: 2027, description: "x", extension: "txt" }).slice(1)).toEqual(["IIBB", "2027", "2027 01", "RETENCIONES Y PERCEPCIONES"]);
    });
    it("bancos por banco y año; sin mes en el nombre", () => {
        const t = { category: "BANCOS" as const, client, year: 2026, bank: "Banco Santa Cruz cc/123", description: "extracto octubre", extension: "PDF" };
        expect(backupFolderPath(t).slice(1)).toEqual(["BANCOS", "BANCO SANTA CRUZ CC 123", "2026"]);
        expect(backupFileName(t)).toBe("2026 EXTRACTO OCTUBRE EMPRESA EJEMPLO S.A.S..pdf");
    });
    it("categoría mensual sin mes: error", () => {
        expect(() => backupFolderPath({ category: "SUELDOS", client, year: 2026, description: "F931", extension: "pdf" })).toThrow(/necesita mes/);
    });
    it("limpia caracteres inválidos", () => {
        expect(cleanSegment('  a/b\\c:d*e?f"g<h>i|j  ')).toBe("A B C D E F G H I J");
    });
    it("extensión: del nombre o del contenido", () => {
        expect(guessExtension("retenciones.TXT", new Uint8Array([1]))).toBe("txt");
        expect(guessExtension(null, new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe("pdf");
        expect(guessExtension(null, new Uint8Array([0x50, 0x4b, 3, 4]))).toBe("xlsx");
        expect(guessExtension(undefined, new Uint8Array([0x41]))).toBe("txt");
    });
    it("sufijo para nombres repetidos", () => {
        expect(withSuffix("2026 10 F931 VEP X.pdf", 2)).toBe("2026 10 F931 VEP X (2).pdf");
    });
    it("escapa comillas en las consultas a Drive", () => {
        expect(qEscape("O'Higgins \\ SA")).toBe("O\\'Higgins \\\\ SA");
    });
});
