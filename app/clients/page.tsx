import Link from "next/link";
import prisma from "@/lib/prisma";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    guardPage,
} from "@/lib/auth/authz";
import { ROLES_READ } from "@/lib/auth/roles";
import { AccessNotice } from "@/app/_components/access-notice";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId } = await resolveActiveOrganization(profileId);
        await requireOrganizationRole(profileId, organizationId, ROLES_READ);
        return prisma.client.findMany({
            where: { organizationId },
            orderBy: { name: "asc" },
        });
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const clients = guard.data;

    return (
        <div className="container">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--spacing-lg)", flexWrap: "wrap", gap: "var(--spacing-md)" }}>
                <div>
                    <h1 style={{ fontSize: "1.5rem", fontWeight: "bold" }}>Clientes</h1>
                    <p style={{ color: "var(--secondary)", fontSize: "0.875rem" }}>Gestiona tus clientes y sus liquidaciones de IVA e IIBB.</p>
                </div>
                <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
                    <Link href="/clients/new" className="btn btn-primary">
                        + Nuevo Cliente
                    </Link>
                </div>
            </div>

            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <table className="table">
                    <thead>
                        <tr>
                            <th>Nombre</th>
                            <th>CUIT</th>
                            <th>Condición</th>
                            <th>Acciones</th>
                        </tr>
                    </thead>
                    <tbody>
                        {clients.length === 0 ? (
                            <tr>
                                <td colSpan={4} style={{ textAlign: "center", padding: "var(--spacing-xl)" }}>
                                    <div style={{ color: "var(--secondary)", marginBottom: "var(--spacing-md)" }}>
                                        No hay clientes registrados aún.
                                    </div>
                                    <div style={{ display: "flex", justifyContent: "center", gap: "var(--spacing-md)" }}>
                                        <Link href="/clients/new" className="btn btn-primary">
                                            Crear Nuevo Cliente
                                        </Link>
                                    </div>
                                </td>
                            </tr>
                        ) : (
                            clients.map((client) => (
                                <tr key={client.id}>
                                    <td style={{ fontWeight: 500 }}>{client.name}</td>
                                    <td>{client.cuit}</td>
                                    <td>
                                        <span className="badge">{client.condition}</span>
                                    </td>
                                    <td>
                                        <Link href={`/client/${client.id}/dashboard`} className="btn btn-secondary" style={{ padding: "0.25rem 0.75rem", fontSize: "0.875rem" }}>
                                            Gestionar Liquidación
                                        </Link>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
