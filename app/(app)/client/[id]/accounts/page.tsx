import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requireClientAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_READ, ROLES_UPDATE, roleAllows } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { NotFoundError } from "@/lib/auth/errors";
import { AccessNotice } from "@/app/_components/access-notice";
import { CHART_MODEL_LABEL, suggestedChartModel, type ChartModel } from "@/lib/accounting/chart-models";
import { idcbComputablePercent, type MipymeCategory } from "@/lib/accounting/profile";
import { AccountingProfileForm } from "./accounting-profile-form";
import { ChartEditor } from "./chart-editor";

export const dynamic = "force-dynamic";

export default async function AccountsPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId, role } = await requireClientAccess(profileId, id, ROLES_READ, { module: MODULES_CLIENT_DIRECTORY });
        const client = await prisma.client.findFirst({
            where: { id, organizationId },
            select: {
                id: true, name: true, chartModel: true, mipymeCategory: true, mipymeManufacturing: true, mipymeValidUntil: true,
                activities: { select: { nomenclator: true, code: true }, orderBy: { createdAt: "asc" } },
                chartAccounts: { select: { id: true, code: true, name: true, imputable: true, active: true, role: true }, orderBy: { code: "asc" } },
            },
        });
        if (!client) throw new NotFoundError();
        return { client, canEdit: roleAllows(ROLES_UPDATE, role) };
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const { client, canEdit } = guard.data;
    const until = client.mipymeValidUntil ? client.mipymeValidUntil.toISOString().slice(0, 10) : null;
    const today = new Date().toISOString().slice(0, 10);
    const idcb = idcbComputablePercent({ mipymeCategory: client.mipymeCategory as MipymeCategory | null, mipymeManufacturing: client.mipymeManufacturing, mipymeValidUntil: until }, today);
    const suggested = suggestedChartModel(client.activities.find((a) => a.nomenclator === "ARCA")?.code ?? null);

    return (
        <div className="container stack-lg">
            <header className="page-header" style={{ marginBottom: 0 }}>
                <div>
                    <p className="eyebrow"><Link href={`/client/${id}/dashboard`}>← Volver al cliente</Link></p>
                    <h1>Plan de cuentas · {client.name}</h1>
                    <p className="subtitle">
                        {client.chartModel ? `Modelo aplicado: ${CHART_MODEL_LABEL[client.chartModel as ChartModel]}.` : "Todavía no tiene plan de cuentas."}
                        {" "}Impuesto a los débitos y créditos computable en Ganancias hoy: <strong>{idcb.percent} %</strong> ({idcb.reason}).
                    </p>
                </div>
            </header>
            <AccountingProfileForm
                clientId={id}
                canEdit={canEdit}
                hasAccounts={client.chartAccounts.length > 0}
                suggested={suggested}
                initial={{ mipymeCategory: client.mipymeCategory ?? "", mipymeManufacturing: client.mipymeManufacturing, mipymeValidUntil: until ?? "" }}
            />
            {client.chartAccounts.length > 0 && <ChartEditor clientId={id} canEdit={canEdit} accounts={client.chartAccounts} />}
        </div>
    );
}
