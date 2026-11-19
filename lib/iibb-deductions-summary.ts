import { Prisma } from "@prisma/client";

/**
 * Resumen de las deducciones de IIBB del período, por jurisdicción y concepto,
 * con su origen: informadas por el fisco (importadas), tomadas de las compras o
 * cargadas a mano. Sirve para controlar contra los resúmenes del fisco (SIRCREB,
 * SIRTAC, e-SICOL, SIFERE) antes de declarar. Función pura.
 */

export const IIBB_SUMMARY_CONCEPTS = ["RETENCION IIBB", "PERCEPCION IIBB", "SIRCREB", "SIRTAC"] as const;
export type IibbSummaryConcept = (typeof IIBB_SUMMARY_CONCEPTS)[number];
export type IibbOrigin = "reported" | "purchases" | "manual";

export interface IibbSummaryCell { total: Prisma.Decimal; count: number; byOrigin: Record<IibbOrigin, Prisma.Decimal> }
export interface IibbSummaryRow { jurisdictionCode: string | null; cells: Record<IibbSummaryConcept, IibbSummaryCell>; total: Prisma.Decimal }

export interface IibbSummaryInput {
    type: string;
    amount: Prisma.Decimal | string | number;
    jurisdictionCode: string | null;
    importSource: string | null;
    fromInvoice: boolean;
}

const zero = () => new Prisma.Decimal(0);
const emptyCell = (): IibbSummaryCell => ({ total: zero(), count: 0, byOrigin: { reported: zero(), purchases: zero(), manual: zero() } });

export function summarizeIibbDeductions(records: readonly IibbSummaryInput[]): IibbSummaryRow[] {
    const rows = new Map<string, IibbSummaryRow>();
    for (const r of records) {
        if (!(IIBB_SUMMARY_CONCEPTS as readonly string[]).includes(r.type)) continue;
        const key = r.jurisdictionCode ?? "";
        let row = rows.get(key);
        if (!row) {
            row = { jurisdictionCode: r.jurisdictionCode, total: zero(), cells: Object.fromEntries(IIBB_SUMMARY_CONCEPTS.map((c) => [c, emptyCell()])) as Record<IibbSummaryConcept, IibbSummaryCell> };
            rows.set(key, row);
        }
        const amount = new Prisma.Decimal(r.amount);
        const cell = row.cells[r.type as IibbSummaryConcept];
        const origin: IibbOrigin = r.importSource ? "reported" : r.fromInvoice ? "purchases" : "manual";
        cell.total = cell.total.plus(amount);
        cell.count++;
        cell.byOrigin[origin] = cell.byOrigin[origin].plus(amount);
        row.total = row.total.plus(amount);
    }
    // Jurisdicciones por código; las cargadas sin jurisdicción, al final.
    return [...rows.values()].sort((a, b) => (a.jurisdictionCode ?? "999").localeCompare(b.jurisdictionCode ?? "999"));
}
