import { Prisma } from "@prisma/client";
import { parseMoney } from "./validation/decimal";

/**
 * Entrada de PUT /api/periods/[id]/vat-position: datos de la posición de IVA
 * que el estudio carga a mano (F.2051 y Portal IVA → Ajustes al Crédito Fiscal).
 *
 *  - previousTechnicalBalance: "Saldo técnico a favor del contribuyente del
 *    período anterior" (>= 0), con su referencia opcional.
 *  - adjustments: un ítem por régimen (a lo sumo uno de cada uno):
 *      · LEY_27541_ANEXO_I: Crédito Fiscal por Contribuciones a la Seguridad
 *        Social - Anexo I Ley 27.541.
 *      · LEY_27467_ART_91: Crédito Fiscal por Contribuciones a la Seguridad
 *        Social - Art. 91 Ley 27.467.
 *    contributionsAmount ("Crédito Fiscal", contribuciones efectivamente
 *    abonadas) y computableAmount ("Crédito Fiscal Computable"), ambos >= 0 y
 *    computable <= contribuciones. Un régimen ausente se borra. La app no
 *    calcula porcentajes: el computable lo informa el estudio.
 *
 * Reemplazo total: el cuerpo describe el estado completo.
 */

export const VAT_CREDIT_ADJUSTMENT_REGIMES = ["LEY_27541_ANEXO_I", "LEY_27467_ART_91"] as const;
export type VatCreditAdjustmentRegimeInput = (typeof VAT_CREDIT_ADJUSTMENT_REGIMES)[number];

export const VAT_CREDIT_ADJUSTMENT_LABELS: Record<VatCreditAdjustmentRegimeInput, string> = {
  LEY_27541_ANEXO_I: "Crédito Fiscal por Contribuciones a la Seguridad Social - Anexo I Ley 27.541",
  LEY_27467_ART_91: "Crédito Fiscal por Contribuciones a la Seguridad Social - Art. 91 Ley 27.467",
};

export const VAT_POSITION_REFERENCE_MAX = 120;

export interface VatCreditAdjustmentData {
  regime: VatCreditAdjustmentRegimeInput;
  contributionsAmount: Prisma.Decimal;
  computableAmount: Prisma.Decimal;
  reference: string | null;
}

export interface VatPositionData {
  previousTechnicalBalance: Prisma.Decimal;
  previousTechnicalBalanceReference: string | null;
  adjustments: VatCreditAdjustmentData[];
}

export type VatPositionInput =
  | { ok: true; data: VatPositionData }
  | { ok: false; field: string; error: string };

const bad = (field: string, error: string): VatPositionInput => ({ ok: false, field, error });

function parseReference(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "la referencia debe ser texto" };
  const t = raw.trim();
  if (Array.from(t).length > VAT_POSITION_REFERENCE_MAX) {
    return { ok: false, error: `referencia demasiado larga (máximo ${VAT_POSITION_REFERENCE_MAX} caracteres)` };
  }
  for (const ch of t) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c === 0x7f) return { ok: false, error: "la referencia tiene caracteres de control" };
  }
  return { ok: true, value: t === "" ? null : t };
}

export function buildVatPositionInput(body: unknown): VatPositionInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("body", "cuerpo inválido");
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!["previousTechnicalBalance", "previousTechnicalBalanceReference", "adjustments"].includes(k)) {
      return bad(k, "campo no admitido");
    }
  }

  const prev = parseMoney(b.previousTechnicalBalance, { allowNegative: false });
  if (!prev.ok) return bad("previousTechnicalBalance", prev.error);
  const prevRef = parseReference(b.previousTechnicalBalanceReference);
  if (!prevRef.ok) return bad("previousTechnicalBalanceReference", prevRef.error);

  if (!Array.isArray(b.adjustments)) return bad("adjustments", "adjustments debe ser una lista");
  if (b.adjustments.length > VAT_CREDIT_ADJUSTMENT_REGIMES.length) return bad("adjustments", "demasiados ajustes");
  const seen = new Set<string>();
  const adjustments: VatCreditAdjustmentData[] = [];
  for (const [i, raw] of b.adjustments.entries()) {
    const f = (name: string) => `adjustments.${i}.${name}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad(`adjustments.${i}`, "ajuste inválido");
    const a = raw as Record<string, unknown>;
    for (const k of Object.keys(a)) {
      if (!["regime", "contributionsAmount", "computableAmount", "reference"].includes(k)) return bad(f(k), "campo no admitido");
    }
    if (typeof a.regime !== "string" || !(VAT_CREDIT_ADJUSTMENT_REGIMES as readonly string[]).includes(a.regime)) {
      return bad(f("regime"), "régimen fuera del catálogo");
    }
    if (seen.has(a.regime)) return bad(f("regime"), "régimen repetido");
    seen.add(a.regime);
    const contributions = parseMoney(a.contributionsAmount, { allowNegative: false });
    if (!contributions.ok) return bad(f("contributionsAmount"), contributions.error);
    const computable = parseMoney(a.computableAmount, { allowNegative: false });
    if (!computable.ok) return bad(f("computableAmount"), computable.error);
    if (computable.value.greaterThan(contributions.value)) {
      return bad(f("computableAmount"), "el crédito computable no puede superar las contribuciones abonadas");
    }
    const ref = parseReference(a.reference);
    if (!ref.ok) return bad(f("reference"), ref.error);
    adjustments.push({
      regime: a.regime as VatCreditAdjustmentRegimeInput,
      contributionsAmount: contributions.value,
      computableAmount: computable.value,
      reference: ref.value,
    });
  }
  adjustments.sort((x, y) => x.regime.localeCompare(y.regime));
  return {
    ok: true,
    data: { previousTechnicalBalance: prev.value, previousTechnicalBalanceReference: prevRef.value, adjustments },
  };
}
