import "server-only";
import { Prisma } from "@prisma/client";
import { todayInArgentina } from "../activity-catalog/date";
import { usableRateRuleSets } from "../iibb-rates/registry";
import { isIibbRegistration } from "./registration";
import { buildAnnualReview, type ReviewPrior, type ReviewRow } from "./annual-review";
import { currentFiscalYear } from "./rate-years";

type Db = Pick<Prisma.TransactionClient, "client" | "clientActivity" | "clientIibbRateYear" | "clientGrossIncomeYear">;

const str = (d: Prisma.Decimal | null | undefined) => (d == null ? null : d.toString());

/**
 * Revisión anual del AÑO EN CURSO para un cliente (lecturas secuenciales para
 * poder usarse dentro de una transacción interactiva). null: cliente inexistente.
 */
export async function loadAnnualReview(db: Db, args: { organizationId: string; clientId: string; today?: string }): Promise<{ year: number; date: string; incomeLoaded: boolean; rows: ReviewRow[] } | null> {
    const { organizationId, clientId } = args;
    const date = args.today ?? todayInArgentina();
    const year = currentFiscalYear(date);
    const client = await db.client.findFirst({ where: { id: clientId, organizationId }, select: { iibbRegistration: true } });
    if (!client) return null;
    const activities = await db.clientActivity.findMany({
        where: { clientId, organizationId },
        select: { code: true, description: true, nomenclator: true, origin: true, catalogId: true, rates: { select: { id: true, jurisdictionCode: true, rate: true, treatment: true, rateOrigin: true, ruleRef: true, minimumAmount: true } } },
        orderBy: [{ code: "asc" }],
    });
    const yearRows = await db.clientIibbRateYear.findMany({
        where: { clientId, organizationId, fiscalYear: { in: [year - 1, year] } },
        select: { fiscalYear: true, jurisdictionCode: true, activityCode: true, rate: true, treatment: true, minimumAmount: true, confirmedAt: true },
    });
    const priorRows = yearRows.filter((r) => r.fiscalYear === year - 1);
    const income = await db.clientGrossIncomeYear.findFirst({ where: { clientId, organizationId, incomeYear: year - 1 }, select: { amount: true } });
    const prior = new Map<string, ReviewPrior>(priorRows.map((p) => [`${p.jurisdictionCode}|${p.activityCode}`, { rate: str(p.rate), treatment: p.treatment, minimum: str(p.minimumAmount) }]));
    const current = new Map<string, ReviewPrior & { confirmedAt: string }>(
        yearRows
            .filter((r) => r.fiscalYear === year)
            .map((p): [string, ReviewPrior & { confirmedAt: string }] => [`${p.jurisdictionCode}|${p.activityCode}`, { rate: str(p.rate), treatment: p.treatment, minimum: str(p.minimumAmount), confirmedAt: p.confirmedAt.toISOString().slice(0, 10) }]),
    );
    const rates = activities.flatMap((a) =>
        a.rates.map((r) => ({
            rateId: r.id,
            jurisdictionCode: r.jurisdictionCode,
            activityCode: a.code,
            description: a.description,
            nomenclator: a.nomenclator,
            catalogId: a.origin === "CATALOG" ? a.catalogId : null,
            rate: str(r.rate),
            treatment: r.treatment,
            origin: r.rateOrigin,
            ruleRef: r.ruleRef,
            minimum: str(r.minimumAmount),
        })),
    );
    rates.sort((x, y) => x.jurisdictionCode.localeCompare(y.jurisdictionCode) || x.activityCode.localeCompare(y.activityCode));
    const rows = buildAnnualReview({
        sets: usableRateRuleSets(),
        date,
        registration: client.iibbRegistration && isIibbRegistration(client.iibbRegistration) ? client.iibbRegistration : null,
        priorYearGrossIncome: income ? income.amount.toFixed(2) : null,
        rates,
        prior,
        current,
    });
    return { year, date, incomeLoaded: income !== null, rows };
}
