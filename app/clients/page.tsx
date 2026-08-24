import Link from "next/link";
import prisma from "@/lib/prisma";


export const dynamic = "force-dynamic";

export default async function ClientsPage() {
    const clients = await prisma.client.findMany({
        orderBy: { name: "asc" },
    });

    return (
        <div className="container">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--spacing-lg)" }}>
                <h1 style={{ fontSize: "1.5rem", fontWeight: "bold" }}>Clientes</h1>
                <Link href="/clients/new" className="btn btn-primary">
                    Nuevo Cliente
                </Link>
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
                                <td colSpan={4} style={{ textAlign: "center", color: "var(--secondary)" }}>
                                    No hay clientes registrados.
                                </td>
                            </tr>
                        ) : (
                            clients.map((client: any) => (
                                <tr key={client.id}>
                                    <td>{client.name}</td>
                                    <td>{client.cuit}</td>
                                    <td>
                                        <span className="badge">{client.condition}</span>
                                    </td>
                                    <td>
                                        <Link href={`/client/${client.id}/dashboard`} style={{ color: "var(--primary)", fontWeight: 500 }}>
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
