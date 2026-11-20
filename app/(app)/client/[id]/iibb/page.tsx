import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requireClientAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_READ, ROLES_UPDATE, roleAllows } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { NotFoundError } from "@/lib/auth/errors";
import { AccessNotice } from "@/app/_components/access-notice";
import { localIibbJurisdiction } from "@/lib/liquidation-totals";
import { IibbActivityForm } from "./iibb-activity-form";

export const dynamic = "force-dynamic";

// Configuración de IIBB por actividad del cliente: actividad principal (por
// defecto para todas las ventas) y puntos de venta asignados a una actividad.
export default async function IibbActivitiesPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId, role } = await requireClientAccess(profileId, id, ROLES_READ, { module: MODULES_CLIENT_DIRECTORY });
        const client = await prisma.client.findFirst({
            where: { id, organizationId },
            select: {
                id: true, name: true, iibbRegistration: true, iibbPrincipalActivityCode: true,
                jurisdictions: { select: { jurisdictionCode: true } },
                activities: { select: { code: true, description: true, rates: { select: { jurisdictionCode: true, rate: true, treatment: true } } }, orderBy: { code: "asc" } },
                posActivities: { select: { pointOfSale: true, activityCode: true }, orderBy: { pointOfSale: "asc" } },
            },
        });
        if (!client) throw new NotFoundError();
        const seen = await prisma.invoice.groupBy({ by: ["pointOfSale"], where: { organizationId, category: "SALES", period: { clientId: id } }, _count: { _all: true } });
        return { client, seenPos: seen.map((s) => s.pointOfSale).sort((a, b) => a - b), canEdit: roleAllows(ROLES_UPDATE, role) };
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const { client, seenPos, canEdit } = guard.data;
    const jur = localIibbJurisdiction(client);
    const activities = client.activities.map((a) => {
        const r = jur ? a.rates.find((x) => x.jurisdictionCode === jur) : undefined;
        const rate = !r ? "sin informar" : r.treatment === "EXEMPT" ? "exenta" : r.rate == null ? "sin informar" : `${r.rate.toFixed(2).replace(".", ",")} %`;
        return { code: a.code, label: `${a.code} · ${a.description}`, rate };
    });

    return (
        <div className="container stack-lg">
            <header className="page-header" style={{ marginBottom: 0 }}>
                <div>
                    <p className="eyebrow"><Link href={`/client/${id}/dashboard`}>← Volver al cliente</Link></p>
                    <h1>IIBB por actividad · {client.name}</h1>
                    <p className="subtitle">
                        Cada venta se liquida con la alícuota de su actividad: primero la corrección manual del comprobante (desde la liquidación de cada período), luego la actividad del punto de venta y, si no hay, la actividad principal.
                        {jur ? ` Jurisdicción local: ${jur}.` : ""}
                    </p>
                </div>
            </header>
            {!jur && (
                <p role="alert">
                    El cálculo por actividad aplica, por ahora, a clientes inscriptos como <strong>local</strong> en una sola jurisdicción. Para Convenio Multilateral la liquidación sigue con la alícuota de la ficha hasta la fase de coeficientes (CM05).
                </p>
            )}
            {activities.length === 0 ? (
                <p role="alert">El cliente no tiene actividades cargadas. Cargalas en <Link href={`/client/${id}/edit`}>Datos del cliente</Link> (o desde la constancia de inscripción).</p>
            ) : (
                <section className="card" aria-labelledby="act-title">
                    <h2 id="act-title" style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>Actividades y alícuotas{jur ? ` en ${jur}` : ""}</h2>
                    <table className="table" style={{ width: "100%" }}>
                        <thead><tr><th>Actividad</th><th style={{ textAlign: "right" }}>Alícuota</th></tr></thead>
                        <tbody>{activities.map((a) => <tr key={a.code}><td>{a.label}{a.code === client.iibbPrincipalActivityCode ? " (principal)" : ""}</td><td style={{ textAlign: "right" }}>{a.rate}</td></tr>)}</tbody>
                    </table>
                    <p style={{ color: "var(--secondary)", fontSize: "0.8125rem", marginTop: "var(--spacing-sm)" }}>Las alícuotas se editan en <Link href={`/client/${id}/edit`}>Datos del cliente</Link>. Una actividad «sin informar» se liquida con la alícuota de respaldo de la ficha y queda advertida en la liquidación.</p>
                </section>
            )}
            {activities.length > 0 && (
                canEdit ? (
                    <IibbActivityForm
                        clientId={id}
                        activities={activities.map((a) => ({ code: a.code, label: a.label }))}
                        principalCode={client.iibbPrincipalActivityCode}
                        pos={client.posActivities}
                        seenPos={seenPos}
                    />
                ) : (
                    <p>Actividad principal: <strong>{client.iibbPrincipalActivityCode ?? "sin definir"}</strong>. Puntos de venta asignados: {client.posActivities.length === 0 ? "ninguno" : client.posActivities.map((p) => `${p.pointOfSale} → ${p.activityCode}`).join(", ")}.</p>
                )
            )}
        </div>
    );
}
