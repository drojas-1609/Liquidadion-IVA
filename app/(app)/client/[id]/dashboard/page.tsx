import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requireClientAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_READ, ROLES_CREATE, ROLES_CLIENT_MANAGE, ROLES_DELETE, roleAllows } from "@/lib/auth/roles";
import { formatPeriodLabel } from "@/lib/period";
import { periodStatusLabel } from "@/lib/period-status";
import { NotFoundError } from "@/lib/auth/errors";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { AccessNotice } from "@/app/_components/access-notice";
import { ClientActions } from "./client-actions";

export const dynamic = "force-dynamic";

export default async function ClientDashboard({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId, role, modules } = await requireClientAccess(profileId, id, ROLES_READ, {
            module: MODULES_CLIENT_DIRECTORY,
        });
        const hasIva = modules.includes("IVA");
        // Los períodos son del módulo IVA: sin él no se leen.
        const full = hasIva
            ? await prisma.client.findFirst({
                  where: { id, organizationId },
                  include: {
                      periods: { orderBy: [{ year: "desc" }, { month: "desc" }] },
                  },
              })
            : await prisma.client.findFirst({ where: { id, organizationId } }).then((c) => (c ? { ...c, periods: [] } : null));
        if (!full) throw new NotFoundError();
        return { client: full, role, hasIva, hasClients: modules.includes("CLIENTS") };
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const { client, role, hasIva, hasClients } = guard.data;
    const canEdit = hasClients && roleAllows(ROLES_CLIENT_MANAGE, role);
    const canDelete = hasClients && roleAllows(ROLES_DELETE, role);
    const canCreatePeriod = hasIva && roleAllows(ROLES_CREATE, role);

    return (
        <div className="container">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--spacing-md)", flexWrap: "wrap", marginBottom: "var(--spacing-xl)" }}>
                <div>
                    <Link href="/clients" style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-xs)", display: "inline-block" }}>
                        &larr; Volver a Clientes
                    </Link>
                    <h1 style={{ fontSize: "2rem", fontWeight: "bold" }}>{client.name}</h1>
                    <div style={{ display: "flex", gap: "var(--spacing-md)", color: "var(--secondary)", marginTop: "var(--spacing-xs)" }}>
                        <span>{client.cuit}</span>
                        <span>•</span>
                        <span>{client.condition}</span>
                    </div>
                </div>
                <ClientActions clientId={client.id} clientName={client.name} canEdit={canEdit} canDelete={canDelete} />
            </div>

            {hasIva && (<>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--spacing-lg)" }}>
                <h2 style={{ fontSize: "1.5rem", fontWeight: "bold" }}>Períodos fiscales</h2>
                {canCreatePeriod && (
                    <Link href={`/client/${id}/period/new`} className="btn btn-primary">
                        Nuevo período
                    </Link>
                )}
            </div>

            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <table className="table">
                    <thead>
                        <tr>
                            <th>Período</th>
                            <th>Estado</th>
                            <th>Acciones</th>
                        </tr>
                    </thead>
                    <tbody>
                        {client.periods.length === 0 ? (
                            <tr>
                                <td colSpan={3} style={{ textAlign: "center", color: "var(--secondary)" }}>
                                    No hay períodos registrados.
                                </td>
                            </tr>
                        ) : (
                            client.periods.map((period) => (
                                <tr key={period.id}>
                                    <td>{formatPeriodLabel(period)}</td>
                                    <td data-period-status={period.status}>{periodStatusLabel(period.status)}</td>
                                    <td>
                                        <Link
                                            href={`/client/${id}/period/${period.id}`}
                                            style={{ color: "var(--primary)", fontWeight: 500, marginRight: "var(--spacing-md)" }}
                                        >
                                            Gestionar
                                        </Link>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
            </>)}
        </div>
    );
}
