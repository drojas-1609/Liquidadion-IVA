import { LiquidationScreen } from "../liquidation/liquidation-view";

export const dynamic = "force-dynamic";

// Liquidación de Ingresos Brutos del período: mismo cálculo que la de IVA (lib/liquidation-calc).
export default async function IibbLiquidationPage({ params }: { params: Promise<{ id: string; periodId: string }> }) {
    return LiquidationScreen({ params, view: "IIBB" });
}
