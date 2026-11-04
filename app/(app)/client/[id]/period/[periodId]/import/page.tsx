import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requirePeriodAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_CREATE } from "@/lib/auth/roles";
import { NotFoundError } from "@/lib/auth/errors";
import { AccessNotice } from "@/app/_components/access-notice";
import { formatPeriodLabel } from "@/lib/period";
import { isPeriodClosed } from "@/lib/period-status";
import { PeriodClosedNotice } from "../_components/period-closed-notice";
import { LibroIvaImport } from "./libro-iva-import";

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
        return period;
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    if (guard.data === null) return <PeriodClosedNotice clientId={id} periodId={periodId} />;
    const period = guard.data;

    return (
        <div className="container">
            <p style={{ marginBottom: "var(--spacing-md)" }}>
                <Link href={`/client/${id}/period/${periodId}`}>← Volver al período</Link>
            </p>
            <h1 style={{ fontSize: "2rem", fontWeight: "bold", marginBottom: "var(--spacing-md)" }}>
                Importar Libro IVA Digital · {formatPeriodLabel(period)}
            </h1>
            <LibroIvaImport
                clientId={id}
                periodId={periodId}
                turivaIncluded={period.vatSettings?.turivaIncluded === true}
                prorationMode={period.vatSettings?.creditProrationMode ?? "NONE"}
            />
        </div>
    );
}
