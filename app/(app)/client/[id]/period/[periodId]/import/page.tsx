import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requirePeriodAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_CONFIG, ROLES_CREATE } from "@/lib/auth/roles";
import { NotFoundError } from "@/lib/auth/errors";
import { AccessNotice } from "@/app/_components/access-notice";
import { formatPeriodLabel } from "@/lib/period";
import { isPeriodClosed } from "@/lib/period-status";
import { PeriodClosedNotice } from "../_components/period-closed-notice";
import { LibroIvaImport } from "./libro-iva-import";
import { ArcaSyncPanel } from "./arca-sync-panel";

export const dynamic = "force-dynamic";

// Importación del Libro IVA Digital: OWNER / ADMIN / ACCOUNTANT (ROLES_CREATE),
// igual que el alta de comprobantes. Período cerrado: aviso (la API rechaza igual).
export default async function ImportPage({ params }: { params: Promise<{ id: string; periodId: string }> }) {
    const { id, periodId } = await params;
    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const access = await requirePeriodAccess(profileId, periodId, ROLES_CREATE, { expectClientId: id });
        if (isPeriodClosed(access.period.status)) return null;
        const period = await prisma.period.findFirst({
            where: { id: periodId, organizationId: access.organizationId },
            select: { month: true, year: true, vatSettings: { select: { turivaIncluded: true, creditProrationMode: true } } },
        });
        if (!period) throw new NotFoundError();
        return { ...period, canSchedule: ROLES_CONFIG.includes(access.role) };
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    if (guard.data === null) return <PeriodClosedNotice clientId={id} periodId={periodId} />;
    const period = guard.data;

    return (
        <div className="container stack-lg">
            <header className="page-header" style={{ marginBottom: 0 }}>
                <div>
                    <p className="eyebrow"><Link href={`/client/${id}/period/${periodId}`}>← Volver al período</Link></p>
                    <h1>Importar comprobantes · {formatPeriodLabel(period)}</h1>
                    <p className="subtitle">Traé los comprobantes desde ARCA o subí los archivos del Libro IVA Digital. Siempre revisás la vista previa antes de incorporar.</p>
                </div>
            </header>
            <ArcaSyncPanel periodId={periodId} canSchedule={period.canSchedule} />
            <LibroIvaImport
                clientId={id}
                periodId={periodId}
                turivaIncluded={period.vatSettings?.turivaIncluded === true}
                prorationMode={period.vatSettings?.creditProrationMode ?? "NONE"}
            />
        </div>
    );
}
