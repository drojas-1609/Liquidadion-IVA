import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { serializeInvoice, serializeTaxRecord, serializeClient, serializeLiquidation } from "@/lib/serializers";
import { computeLiquidation, type PeriodForCalc } from "@/lib/liquidation-calc";

const repo = fileURLToPath(new URL("../", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e === "route.ts") out.push(p);
  }
  return out;
}

/**
 * Inventario definitivo de rutas API y su tratamiento de decimales.
 * `models`: modelos con Decimal que la ruta puede devolver.
 * `serializer`: serializador explícito esperado, o null si la ruta no expone
 * decimales (se justifica en el comentario).
 */
const EXPECTED = {
  "app/api/clients/route.ts": { models: ["Client"], serializer: "serializeClient" },
  "app/api/invoices/route.ts": { models: ["Invoice"], serializer: "serializeInvoice" },
  "app/api/taxes/route.ts": { models: ["TaxRecord"], serializer: "serializeTaxRecord" },
  // Period no tiene campos Decimal, pero igual se serializa (serializePeriod)
  // para NO exponer organizationId/createdById/updatedById.
  "app/api/periods/route.ts": { models: [], serializer: "serializePeriod" },
  // Devuelve XLSX binario (no JSON); internamente serializeLiquidation -> strings.
  "app/api/client/[id]/period/[periodId]/export/route.ts": { models: ["Invoice", "TaxRecord", "Client"], serializer: "serializeLiquidation" },
} as const;

describe("auditoría de serialización de decimales (punto 2)", () => {
  it("el inventario cubre TODAS las rutas bajo app/api/**", () => {
    const found = walk(join(repo, "app/api"))
      .map((p) => p.slice(repo.length))
      .sort();
    expect(found).toEqual(Object.keys(EXPECTED).sort());
  });

  it("Period NO tiene campos Decimal (por eso /api/periods no serializa)", () => {
    const schema = readFileSync(join(repo, "prisma/schema.prisma"), "utf8");
    const periodBlock = schema.slice(schema.indexOf("model Period {"), schema.indexOf("}", schema.indexOf("model Period {")));
    expect(periodBlock).not.toMatch(/Decimal/);
  });

  it("cada ruta que puede devolver un modelo con Decimal usa serialización explícita", () => {
    for (const [rel, cfg] of Object.entries(EXPECTED)) {
      const src = readFileSync(join(repo, rel), "utf8");
      if (cfg.serializer) {
        expect(src, `${rel} debe importar ${cfg.serializer}`).toContain(cfg.serializer);
      }
      // ninguna ruta debe hacer NextResponse.json(<entidad prisma cruda>)
      expect(src, `${rel} no debe responder prisma.* crudo`).not.toMatch(
        /NextResponse\.json\(\s*(newInvoice|newClient|newTaxRecord|period|invoice|client)\s*\)/,
      );
      // no se depende de Decimal.toJSON() implícito
      expect(src).not.toMatch(/toJSON/);
    }
  });

  it("respuesta anidada (liquidación: period -> invoices/taxRecords/client): todo string", () => {
    const D = (v: string) => new Prisma.Decimal(v);
    const period: PeriodForCalc = {
      client: { defaultIibbRate: D("3.5") },
      invoices: [
        { category: "SALES", netAmount: D("100.00"), vatAmount: D("21.00"), totalAmount: D("121.00") },
        { category: "PURCHASES", netAmount: D("50.00"), vatAmount: D("10.50"), totalAmount: D("60.50") },
      ],
      taxRecords: [{ type: "RETENCION IVA", amount: D("5.00") }],
    };
    const dto = serializeLiquidation(computeLiquidation(period));

    const allStrings = (o: unknown): boolean =>
      typeof o === "object" && o !== null
        ? Object.values(o).every((v) => (typeof v === "object" ? allStrings(v) : typeof v === "string"))
        : typeof o === "string";

    expect(allStrings(dto)).toBe(true);
    expect(dto.sales.net).toBe("100.00");
    expect(dto.iibb.rate).toBe("3.5");
    // round-trip JSON estable
    expect(JSON.parse(JSON.stringify(dto)).iva.debit).toBe("21.00");
  });

  it("serializeInvoice / serializeTaxRecord / serializeClient: cero Decimal en el JSON", () => {
    const D = (v: string) => new Prisma.Decimal(v);
    const inv = serializeInvoice({
      id: "i", date: new Date(0), type: "FC A", pointOfSale: 1, number: 1,
      entityName: "e", entityCuit: "c", netAmount: D("1"), vatRate: D("21"),
      vatAmount: D("0.21"), totalAmount: D("1.21"), category: "SALES", periodId: "p",
    });
    const tax = serializeTaxRecord({ id: "t", date: new Date(0), type: "X", amount: D("2"), description: null, periodId: "p" });
    const cli = serializeClient({
      id: "c", name: "n", cuit: "q", condition: "RI", address: null,
      defaultIibbRate: D("3"), createdAt: new Date(0), updatedAt: new Date(0),
    });
    for (const o of [inv, tax, cli]) {
      for (const v of Object.values(o)) {
        expect(v instanceof Prisma.Decimal).toBe(false);
      }
    }
  });
});
