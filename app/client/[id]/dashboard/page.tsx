import Link from "next/link";
import prisma, { ensureDb } from "@/lib/prisma";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ClientDashboard({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    await ensureDb();

    let client = null;
    try {
        client = await prisma.client.findUnique({
            where: { id },
            include: {
                periods: {
                    orderBy: [{ year: "desc" }, { month: "desc" }],
                },
            },
        });
    } catch (e) {
        console.error(e);
    }

    if (!client) {
        redirect("/clients");
    }

    return (
        <div className="container">
            <div style={{ marginBottom: "var(--spacing-xl)" }}>
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

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--spacing-lg)" }}>
                <h2 style={{ fontSize: "1.5rem", fontWeight: "bold" }}>Periodos Fiscales</h2>
                <Link href={`/client/${id}/period/new`} className="btn btn-primary">
                    Nuevo Periodo
                </Link>
            </div>

            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <table className="table">
                    <thead>
                        <tr>
                            <th>Periodo</th>
                            <th>Estado</th>
                            <th>Acciones</th>
                        </tr>
                    </thead>
                    <tbody>
                        {client.periods.length === 0 ? (
                            <tr>
                                <td colSpan={3} style={{ textAlign: "center", color: "var(--secondary)" }}>
                                    No hay periodos registrados.
                                </td>
                            </tr>
                        ) : (
                            client.periods.map((period: any) => (
                                <tr key={period.id}>
                                    <td>
                                        {period.month.toString().padStart(2, "0")}/{period.year}
                                    </td>
                                    <td>
                                        <span className="badge">Abierto</span>
                                    </td>
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
        </div>
    );
}
