import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requireClientAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_READ, ROLES_UPDATE, roleAllows } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { NotFoundError } from "@/lib/auth/errors";
import { AccessNotice } from "@/app/_components/access-notice";
import { BACKUP_CATEGORY_LABEL, clientFolderName, type BackupCategory } from "@/lib/drive/naming";
import { BackupActions } from "./backup-actions";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { PENDING: "Pendiente", DONE: "En Drive", ERROR: "Con error" };
const fmt = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

export default async function BackupsPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId, role } = await requireClientAccess(profileId, id, ROLES_READ, { module: MODULES_CLIENT_DIRECTORY });
        const client = await prisma.client.findFirst({
            where: { id, organizationId },
            select: {
                id: true, name: true, cuit: true,
                periods: { select: { id: true, month: true, year: true }, orderBy: [{ year: "desc" }, { month: "desc" }] },
                documentBackups: {
                    select: { id: true, category: true, folderPath: true, fileName: true, size: true, status: true, lastError: true, driveLink: true, createdAt: true, source: true },
                    orderBy: { createdAt: "desc" }, take: 200,
                },
            },
        });
        if (!client) throw new NotFoundError();
        const connected = (await prisma.driveConnection.count({ where: { organizationId } })) > 0;
        return { client, connected, canEdit: roleAllows(ROLES_UPDATE, role) };
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const { client, connected, canEdit } = guard.data;
    const periods = client.periods.map((p) => ({ id: p.id, label: `${String(p.month).padStart(2, "0")}/${p.year}` }));
    const pendingCount = client.documentBackups.filter((b) => b.status !== "DONE").length;
    return (
        <div className="container stack-lg">
            <header className="page-header" style={{ marginBottom: 0 }}>
                <div>
                    <p className="eyebrow"><Link href={`/client/${id}/dashboard`}>← Volver al cliente</Link></p>
                    <h1>Respaldos · {client.name}</h1>
                    <p className="subtitle">Carpeta en Drive: <strong>DERO COMPANY GESTIÓN / {clientFolderName(client.name, client.cuit)}</strong>. Los archivos de las importaciones se respaldan solos; acá podés subir el resto (F.931, VEP, DDJJ, extractos…).</p>
                </div>
            </header>
            {!connected && <p role="alert">Google Drive no está conectado: los comprobantes quedan en cola. Conectalo en <Link href="/settings/drive">Configuración → Drive</Link>.</p>}
            {canEdit && <BackupActions clientId={id} periods={periods} pendingCount={pendingCount} />}
            <section className="card" aria-labelledby="list-title">
                <h2 id="list-title" style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>Archivos respaldados ({client.documentBackups.length})</h2>
                {client.documentBackups.length === 0 ? <p>Todavía no hay respaldos.</p> : (
                    <table className="table" style={{ width: "100%" }}>
                        <thead><tr><th>Fecha</th><th>Tipo</th><th>Archivo</th><th>Estado</th></tr></thead>
                        <tbody>
                            {client.documentBackups.map((b) => (
                                <tr key={b.id}>
                                    <td>{fmt(b.createdAt)}</td>
                                    <td>{BACKUP_CATEGORY_LABEL[b.category as BackupCategory] ?? b.category}</td>
                                    <td>
                                        <div>{b.driveLink ? <a href={b.driveLink} target="_blank" rel="noreferrer">{b.fileName}</a> : b.fileName}</div>
                                        <div className="hint">{b.folderPath.split("/").slice(1).join(" / ")} · {(b.size / 1024).toFixed(0)} KB</div>
                                    </td>
                                    <td>{STATUS[b.status] ?? b.status}{b.lastError ? <div className="hint">{b.lastError}</div> : null}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>
        </div>
    );
}
