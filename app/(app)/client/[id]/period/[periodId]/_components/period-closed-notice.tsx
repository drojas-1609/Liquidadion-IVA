import Link from "next/link";
import { PERIOD_CLOSE_IIBB_NOTICE, PERIOD_CLOSE_SCOPE_NOTICE } from "@/lib/period-status";

/**
 * Reemplaza a los formularios de alta y edición cuando el período está
 * CERRADO. Sólo informa: la API rechaza igual cualquier escritura (409
 * PERIOD_CLOSED), aunque la pantalla se haya cargado antes del cierre.
 */
export function PeriodClosedNotice({ clientId, periodId }: { clientId: string; periodId: string }) {
    return (
        <div className="container" style={{ maxWidth: "560px" }}>
            <div className="card" role="status">
                <h1 style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>Período cerrado</h1>
                <p style={{ color: "var(--secondary)", marginBottom: "var(--spacing-sm)" }}>{PERIOD_CLOSE_SCOPE_NOTICE}</p>
                <p style={{ color: "var(--secondary)" }}>{PERIOD_CLOSE_IIBB_NOTICE}</p>
                <div style={{ marginTop: "var(--spacing-lg)" }}>
                    <Link href={`/client/${clientId}/period/${periodId}`} className="btn btn-secondary">
                        Volver al período
                    </Link>
                </div>
            </div>
        </div>
    );
}
