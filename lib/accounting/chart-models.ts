/**
 * Planes de cuentas modelo aprobados por el estudio el 19/11/2026
 * (documento del proyecto «plan-de-cuentas-modelo.md»):
 *  - COMMERCIAL: empresa comercializadora (Modelo A);
 *  - SERVICES: empresa de servicios (Modelo B).
 * Estructura RT 8/9 FACPCE: 1 Activo · 2 Pasivo · 3 PN · 4 Ingresos · 5 Egresos.
 * Código de 4 segmentos «C.RR.CC.SS»; los rubros (sin subcuenta) son títulos y
 * las cuentas de 4 segmentos, imputables.
 *
 * `role`: cuentas que usan los asientos automáticos (IVA, IIBB, bancos, pagos,
 * sueldos). Cada cliente puede reasignar el rol a otra cuenta de su plan.
 * Función pura, sin Prisma.
 */

export const CHART_MODELS = ["COMMERCIAL", "SERVICES"] as const;
export type ChartModel = (typeof CHART_MODELS)[number];
export const CHART_MODEL_LABEL: Record<ChartModel, string> = {
    COMMERCIAL: "Empresa comercializadora",
    SERVICES: "Empresa de servicios",
};

export const ACCOUNT_ROLES = [
    "CASH", "BANK", "CARD_COLLECTIONS", "WALLET", "BROKER", "FAL",
    "CUSTOMERS", "VAT_CREDIT", "VAT_PERCEPTIONS", "VAT_RETENTIONS", "VAT_TECH_BALANCE", "VAT_FREE_BALANCE",
    "IIBB_RETENTIONS", "IIBB_PERCEPTIONS", "IIBB_SIRCREB", "IIBB_SIRTAC", "IIBB_BALANCE", "IIBB_PAYMENTS",
    "NATIONAL_PERCEPTIONS", "IDCB_COMPUTABLE", "PURCHASES",
    "SUPPLIERS", "SALARIES_PAYABLE", "SOCIAL_SECURITY_PAYABLE", "UNION_PAYABLE", "FAL_PAYABLE",
    "VAT_DEBIT", "VAT_PAYABLE", "IIBB_PAYABLE",
    "SALES_TAXED", "SALES_EXEMPT", "FAL_INCOME",
    "INTERNAL_TAXES_COST", "SALARIES_EXPENSE", "SOCIAL_SECURITY_EXPENSE", "IIBB_EXPENSE",
    "BANK_FEES", "IDCB_EXPENSE", "TAX_INTEREST",
] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export const ACCOUNT_ROLE_LABEL: Record<AccountRole, string> = {
    CASH: "Caja", BANK: "Banco (cuenta por defecto)", CARD_COLLECTIONS: "Cobranzas con tarjeta a acreditar",
    WALLET: "Billetera virtual (por defecto)", BROKER: "Cuenta comitente (por defecto)", FAL: "Fondo de Asistencia Laboral",
    CUSTOMERS: "Deudores por ventas", VAT_CREDIT: "IVA crédito fiscal", VAT_PERCEPTIONS: "IVA percepciones sufridas",
    VAT_RETENTIONS: "IVA retenciones sufridas", VAT_TECH_BALANCE: "IVA saldo técnico a favor", VAT_FREE_BALANCE: "IVA saldo de libre disponibilidad",
    IIBB_RETENTIONS: "IIBB retenciones sufridas", IIBB_PERCEPTIONS: "IIBB percepciones sufridas", IIBB_SIRCREB: "IIBB recaudaciones bancarias (SIRCREB)",
    IIBB_SIRTAC: "IIBB recaudaciones de tarjetas (SIRTAC)", IIBB_BALANCE: "IIBB saldo a favor", IIBB_PAYMENTS: "IIBB pagos a cuenta",
    NATIONAL_PERCEPTIONS: "Otras percepciones nacionales", IDCB_COMPUTABLE: "Impuesto a los débitos y créditos computable en Ganancias",
    PURCHASES: "Compras / mercaderías", SUPPLIERS: "Proveedores", SALARIES_PAYABLE: "Sueldos a pagar",
    SOCIAL_SECURITY_PAYABLE: "Cargas sociales a pagar (F.931)", UNION_PAYABLE: "Sindicato a pagar", FAL_PAYABLE: "Contribuciones al FAL a depositar",
    VAT_DEBIT: "IVA débito fiscal", VAT_PAYABLE: "IVA a pagar", IIBB_PAYABLE: "IIBB a pagar",
    SALES_TAXED: "Ventas gravadas", SALES_EXEMPT: "Ventas exentas / no gravadas", FAL_INCOME: "Rendimientos del FAL",
    INTERNAL_TAXES_COST: "Impuestos internos sobre compras", SALARIES_EXPENSE: "Sueldos y jornales",
    SOCIAL_SECURITY_EXPENSE: "Cargas sociales", IIBB_EXPENSE: "Impuesto sobre los Ingresos Brutos",
    BANK_FEES: "Gastos y comisiones bancarias", IDCB_EXPENSE: "Impuesto a los débitos y créditos (no computable)", TAX_INTEREST: "Intereses y recargos fiscales",
};

export interface ModelAccount { code: string; name: string; role?: AccountRole }

/** Rubros y cuentas comunes a los dos modelos. `COMMON_*` se arman en orden de código. */
const ASSETS_HEAD: ModelAccount[] = [
    { code: "1", name: "ACTIVO" },
    { code: "1.01", name: "Caja y Bancos" },
    { code: "1.01.01.01", name: "Caja", role: "CASH" },
    { code: "1.01.01.02", name: "Fondo fijo" },
    { code: "1.01.02.01", name: "Banco cuenta corriente", role: "BANK" },
    { code: "1.01.03.01", name: "Valores a depositar" },
    { code: "1.01.04.01", name: "Cobranzas con tarjeta a acreditar", role: "CARD_COLLECTIONS" },
    { code: "1.01.05.01", name: "Billetera virtual Mercado Pago", role: "WALLET" },
    { code: "1.01.06.01", name: "Cuenta comitente — saldo en pesos", role: "BROKER" },
    { code: "1.01.06.02", name: "Cuenta comitente — saldo en moneda extranjera" },
    { code: "1.02", name: "Inversiones" },
    { code: "1.02.01.01", name: "Plazos fijos" },
    { code: "1.02.01.02", name: "Fondos comunes de inversión" },
    { code: "1.02.02.01", name: "Títulos públicos y obligaciones negociables" },
    { code: "1.02.02.02", name: "Acciones y CEDEARs" },
    { code: "1.02.02.03", name: "Cauciones bursátiles" },
    { code: "1.02.03.01", name: "Fondo de Asistencia Laboral (FAL) — uso restringido", role: "FAL" },
    { code: "1.03", name: "Créditos por ventas" },
    { code: "1.03.01.01", name: "Deudores por ventas", role: "CUSTOMERS" },
    { code: "1.03.01.02", name: "Documentos a cobrar" },
    { code: "1.03.01.03", name: "Tarjetas de crédito a cobrar" },
    { code: "1.03.01.99", name: "(−) Previsión para deudores incobrables" },
    { code: "1.04", name: "Otros créditos" },
    { code: "1.04.01.01", name: "IVA crédito fiscal", role: "VAT_CREDIT" },
    { code: "1.04.01.02", name: "IVA percepciones sufridas", role: "VAT_PERCEPTIONS" },
    { code: "1.04.01.03", name: "IVA retenciones sufridas", role: "VAT_RETENTIONS" },
    { code: "1.04.01.04", name: "IVA saldo técnico a favor", role: "VAT_TECH_BALANCE" },
    { code: "1.04.01.05", name: "IVA saldo de libre disponibilidad", role: "VAT_FREE_BALANCE" },
    { code: "1.04.02.01", name: "IIBB retenciones sufridas", role: "IIBB_RETENTIONS" },
    { code: "1.04.02.02", name: "IIBB percepciones sufridas", role: "IIBB_PERCEPTIONS" },
    { code: "1.04.02.03", name: "IIBB recaudaciones bancarias (SIRCREB)", role: "IIBB_SIRCREB" },
    { code: "1.04.02.04", name: "IIBB recaudaciones de tarjetas (SIRTAC)", role: "IIBB_SIRTAC" },
    { code: "1.04.02.05", name: "IIBB saldo a favor", role: "IIBB_BALANCE" },
    { code: "1.04.02.06", name: "IIBB pagos a cuenta", role: "IIBB_PAYMENTS" },
    { code: "1.04.03.01", name: "Otras percepciones nacionales sufridas", role: "NATIONAL_PERCEPTIONS" },
    { code: "1.04.03.02", name: "Anticipos de Impuesto a las Ganancias" },
    { code: "1.04.03.03", name: "Impuesto a los débitos y créditos computable en Ganancias", role: "IDCB_COMPUTABLE" },
    { code: "1.04.04.01", name: "Anticipos a proveedores" },
    { code: "1.04.05.01", name: "Gastos pagados por adelantado" },
];

const ASSETS_TAIL: ModelAccount[] = [
    { code: "1.06", name: "Bienes de uso" },
    { code: "1.06.01.01", name: "Rodados" },
    { code: "1.06.01.91", name: "(−) Amortización acumulada rodados" },
    { code: "1.06.02.01", name: "Muebles y útiles" },
    { code: "1.06.02.91", name: "(−) Amortización acumulada muebles y útiles" },
    { code: "1.06.03.01", name: "Instalaciones" },
    { code: "1.06.03.91", name: "(−) Amortización acumulada instalaciones" },
    { code: "1.06.04.01", name: "Equipos de computación" },
    { code: "1.06.04.91", name: "(−) Amortización acumulada equipos de computación" },
    { code: "1.07", name: "Activos intangibles" },
    { code: "1.07.01.01", name: "Software y licencias" },
    { code: "1.07.01.91", name: "(−) Amortización acumulada software y licencias" },
];

const LIABILITIES_EQUITY: ModelAccount[] = [
    { code: "2", name: "PASIVO" },
    { code: "2.01", name: "Deudas comerciales" },
    { code: "2.01.01.01", name: "Proveedores", role: "SUPPLIERS" },
    { code: "2.01.01.02", name: "Documentos a pagar" },
    { code: "2.01.01.03", name: "Tarjeta de crédito a pagar" },
    { code: "2.02", name: "Deudas bancarias y financieras" },
    { code: "2.02.01.01", name: "Préstamos bancarios" },
    { code: "2.02.01.02", name: "Descubiertos bancarios" },
    { code: "2.03", name: "Remuneraciones y cargas sociales" },
    { code: "2.03.01.01", name: "Sueldos a pagar", role: "SALARIES_PAYABLE" },
    { code: "2.03.01.02", name: "Cargas sociales a pagar (F.931)", role: "SOCIAL_SECURITY_PAYABLE" },
    { code: "2.03.01.03", name: "Sindicato a pagar", role: "UNION_PAYABLE" },
    { code: "2.03.01.04", name: "Provisión SAC y vacaciones" },
    { code: "2.03.01.05", name: "Contribuciones al FAL a depositar", role: "FAL_PAYABLE" },
    { code: "2.04", name: "Deudas fiscales" },
    { code: "2.04.01.01", name: "IVA débito fiscal", role: "VAT_DEBIT" },
    { code: "2.04.01.02", name: "IVA a pagar", role: "VAT_PAYABLE" },
    { code: "2.04.02.01", name: "IIBB a pagar", role: "IIBB_PAYABLE" },
    { code: "2.04.03.01", name: "Impuesto a las Ganancias a pagar" },
    { code: "2.04.03.02", name: "Retenciones y percepciones a depositar" },
    { code: "2.04.04.01", name: "Tasas municipales a pagar" },
    { code: "2.04.04.02", name: "Impuestos internos a pagar" },
    { code: "2.04.05.01", name: "Planes de facilidades de pago" },
    { code: "2.05", name: "Otras deudas" },
    { code: "2.05.01.01", name: "Anticipos de clientes" },
    { code: "2.05.01.02", name: "Cuentas particulares de socios" },
    { code: "2.05.01.03", name: "Dividendos y honorarios a pagar" },
    { code: "2.06", name: "Previsiones" },
    { code: "2.06.01.01", name: "Previsión para contingencias" },
    { code: "2.06.01.02", name: "Previsión para indemnizaciones laborales" },
    { code: "3", name: "PATRIMONIO NETO" },
    { code: "3.01", name: "Capital" },
    { code: "3.01.01.01", name: "Capital social" },
    { code: "3.01.01.02", name: "Ajuste de capital" },
    { code: "3.02", name: "Reservas" },
    { code: "3.02.01.01", name: "Reserva legal" },
    { code: "3.02.01.02", name: "Reservas facultativas" },
    { code: "3.03", name: "Resultados acumulados" },
    { code: "3.03.01.01", name: "Resultados no asignados" },
    { code: "3.03.01.02", name: "Resultado del ejercicio" },
];

const OTHER_INCOME: ModelAccount[] = [
    { code: "4.02", name: "Resultados financieros positivos" },
    { code: "4.02.01.01", name: "Intereses ganados" },
    { code: "4.02.01.02", name: "Descuentos obtenidos" },
    { code: "4.02.01.03", name: "Diferencias de cambio positivas" },
    { code: "4.02.01.04", name: "Resultados por tenencia y venta de inversiones" },
    { code: "4.02.01.05", name: "Rendimientos del FAL (exentos)", role: "FAL_INCOME" },
    { code: "4.02.01.06", name: "Rendimientos de billeteras virtuales y FCI" },
    { code: "4.03", name: "Otros ingresos" },
    { code: "4.03.01.01", name: "Otros ingresos" },
    { code: "4.03.01.02", name: "Resultado por venta de bienes de uso" },
];

const ADMIN_FIN_TAX: ModelAccount[] = [
    { code: "5.03", name: "Gastos de administración" },
    { code: "5.03.01.01", name: "Sueldos y jornales (administración)" },
    { code: "5.03.01.02", name: "Cargas sociales (administración)" },
    { code: "5.03.01.03", name: "Honorarios profesionales" },
    { code: "5.03.01.04", name: "Alquileres" },
    { code: "5.03.01.05", name: "Servicios públicos" },
    { code: "5.03.01.06", name: "Seguros" },
    { code: "5.03.01.07", name: "Papelería y útiles" },
    { code: "5.03.01.08", name: "Mantenimiento y reparaciones" },
    { code: "5.03.01.09", name: "Tasas municipales" },
    { code: "5.03.01.10", name: "Amortizaciones de bienes de uso" },
    { code: "5.03.01.11", name: "Gastos varios" },
    { code: "5.03.01.12", name: "Contribuciones al Fondo de Asistencia Laboral (FAL)" },
    { code: "5.03.01.13", name: "Indemnizaciones laborales no cubiertas por el FAL" },
    { code: "5.04", name: "Gastos financieros" },
    { code: "5.04.01.01", name: "Gastos y comisiones bancarias y de billeteras", role: "BANK_FEES" },
    { code: "5.04.01.02", name: "Impuesto a los débitos y créditos (no computable)", role: "IDCB_EXPENSE" },
    { code: "5.04.01.03", name: "Intereses pagados" },
    { code: "5.04.01.04", name: "Diferencias de cambio negativas" },
    { code: "5.04.01.05", name: "Intereses y recargos fiscales", role: "TAX_INTEREST" },
    { code: "5.04.01.06", name: "Comisiones y derechos de mercado (ALyC)" },
    { code: "5.05", name: "Impuesto a las Ganancias" },
    { code: "5.05.01.01", name: "Impuesto a las Ganancias del ejercicio" },
];

const COMMERCIAL: ModelAccount[] = [
    ...ASSETS_HEAD,
    { code: "1.05", name: "Bienes de cambio" },
    { code: "1.05.01.01", name: "Mercaderías de reventa", role: "PURCHASES" },
    { code: "1.05.01.02", name: "Mercaderías en tránsito" },
    ...ASSETS_TAIL,
    ...LIABILITIES_EQUITY,
    { code: "4", name: "INGRESOS" },
    { code: "4.01", name: "Ventas" },
    { code: "4.01.01.01", name: "Ventas de mercaderías (gravadas)", role: "SALES_TAXED" },
    { code: "4.01.01.02", name: "Ventas exentas / no gravadas", role: "SALES_EXEMPT" },
    { code: "4.01.01.03", name: "(−) Devoluciones, bonificaciones y descuentos sobre ventas" },
    ...OTHER_INCOME,
    { code: "5", name: "EGRESOS" },
    { code: "5.01", name: "Costo de ventas" },
    { code: "5.01.01.01", name: "Costo de mercaderías vendidas" },
    { code: "5.01.01.02", name: "Fletes y acarreos sobre compras" },
    { code: "5.01.01.03", name: "Impuestos internos sobre compras", role: "INTERNAL_TAXES_COST" },
    { code: "5.02", name: "Gastos de comercialización" },
    { code: "5.02.01.01", name: "Sueldos y jornales (comercialización)", role: "SALARIES_EXPENSE" },
    { code: "5.02.01.02", name: "Cargas sociales (comercialización)", role: "SOCIAL_SECURITY_EXPENSE" },
    { code: "5.02.01.03", name: "Impuesto sobre los Ingresos Brutos", role: "IIBB_EXPENSE" },
    { code: "5.02.01.04", name: "Comisiones de tarjetas y medios de pago" },
    { code: "5.02.01.05", name: "Publicidad y propaganda" },
    { code: "5.02.01.06", name: "Fletes sobre ventas" },
    { code: "5.02.01.07", name: "Embalajes" },
    ...ADMIN_FIN_TAX,
];

const SERVICES: ModelAccount[] = [
    ...ASSETS_HEAD,
    { code: "1.05", name: "Materiales e insumos" },
    { code: "1.05.01.01", name: "Materiales e insumos", role: "PURCHASES" },
    { code: "1.05.01.02", name: "Trabajos en curso" },
    ...ASSETS_TAIL,
    ...LIABILITIES_EQUITY,
    { code: "4", name: "INGRESOS" },
    { code: "4.01", name: "Ingresos por servicios" },
    { code: "4.01.01.01", name: "Ingresos por servicios (gravados)", role: "SALES_TAXED" },
    { code: "4.01.01.02", name: "Ingresos por servicios exentos / no gravados", role: "SALES_EXEMPT" },
    { code: "4.01.01.03", name: "(−) Bonificaciones sobre servicios" },
    { code: "4.01.01.04", name: "Reintegros de gastos a clientes" },
    ...OTHER_INCOME,
    { code: "5", name: "EGRESOS" },
    { code: "5.01", name: "Costo de los servicios prestados" },
    { code: "5.01.01.01", name: "Sueldos y jornales (personal operativo)", role: "SALARIES_EXPENSE" },
    { code: "5.01.01.02", name: "Cargas sociales (personal operativo)", role: "SOCIAL_SECURITY_EXPENSE" },
    { code: "5.01.01.03", name: "Materiales e insumos consumidos" },
    { code: "5.01.01.04", name: "Subcontratación de servicios y honorarios de terceros" },
    { code: "5.01.01.05", name: "Combustibles y lubricantes" },
    { code: "5.01.01.06", name: "Viáticos y movilidad" },
    { code: "5.01.01.07", name: "Mantenimiento de equipos y rodados" },
    { code: "5.01.01.08", name: "Impuestos internos sobre compras", role: "INTERNAL_TAXES_COST" },
    { code: "5.02", name: "Gastos de comercialización" },
    { code: "5.02.01.03", name: "Impuesto sobre los Ingresos Brutos", role: "IIBB_EXPENSE" },
    { code: "5.02.01.04", name: "Comisiones de medios de pago" },
    { code: "5.02.01.05", name: "Publicidad y propaganda" },
    ...ADMIN_FIN_TAX,
];

export function chartModelAccounts(model: ChartModel): ModelAccount[] {
    return model === "COMMERCIAL" ? COMMERCIAL : SERVICES;
}

/** Cuenta imputable: código de 4 segmentos (los rubros son títulos). */
export function isImputableCode(code: string): boolean {
    return /^\d\.\d{2}\.\d{2}\.\d{2}$/.test(code);
}

/** Subcuenta «N.NN.NN.NN.SS» (p. ej. un banco puntual dentro de «Banco cuenta corriente»). Siempre imputable. */
export function isSubaccountCode(code: string): boolean {
    return /^[1-5]\.\d{2}\.\d{2}\.\d{2}\.\d{2}$/.test(code);
}

/** Código válido del plan: capítulo «N», rubro «N.NN» o cuenta «N.NN.NN.NN». */
export function isAccountCode(code: string): boolean {
    return /^[1-5](\.\d{2}(\.\d{2}\.\d{2})?)?$/.test(code);
}

/**
 * Modelo sugerido por la actividad principal (CLAE de ARCA): comercio
 * (sección G, códigos 45xxxx a 47xxxx) → comercializadora; el resto, servicios.
 */
export function suggestedChartModel(mainActivityCode: string | null | undefined): ChartModel | null {
    if (!mainActivityCode) return null;
    const d = mainActivityCode.replace(/\D/g, "");
    if (d.length < 2) return null;
    const div = Number(d.slice(0, 2));
    return div >= 45 && div <= 47 ? "COMMERCIAL" : "SERVICES";
}
