import { LiquidationScreen } from "./liquidation-view";

export const dynamic = "force-dynamic";

// Liquidación de IVA del período (el módulo de Ingresos Brutos está en ../iibb-liquidation).
export default async function LiquidationPage({ params }: { params: Promise<{ id: string; periodId: string }> }) {
    return LiquidationScreen({ params, view: "IVA" });
}
