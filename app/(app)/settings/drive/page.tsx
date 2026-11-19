import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireOrganizationRole, guardPage } from "@/lib/auth/authz";
import { ROLES_CONFIG } from "@/lib/auth/roles";
import { AccessNotice } from "@/app/_components/access-notice";
import { driveOAuthConfig } from "@/lib/drive/google";
import { driveTokenKey } from "@/lib/drive/backup-service";
import { DisconnectDriveButton } from "./disconnect-button";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
    estado: "La conexión venció o no coincide con tu sesión. Probá de nuevo.",
    cancelado: "Se canceló la autorización en Google.",
    config: "Falta configurar la credencial de Google en Netlify.",
    google: "Google rechazó la autorización. Revisá que la URL de retorno esté registrada en el cliente OAuth.",
    sin_refresh: "Google no entregó un permiso permanente. Quitá el acceso de la app en la cuenta de Google y volvé a conectar.",
    carpeta: "No se pudo ubicar ni crear la carpeta raíz en Mi unidad.",
};

export default async function DriveSettingsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
    const sp = await searchParams;
    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId } = await resolveActiveOrganization(profileId);
        await requireOrganizationRole(profileId, organizationId, ROLES_CONFIG, { module: "CLIENTS" });
        const conn = await prisma.driveConnection.findUnique({ where: { organizationId }, select: { email: true, rootFolderName: true, connectedAt: true } });
        const [pending, failed, done] = await Promise.all([
            prisma.documentBackup.count({ where: { organizationId, status: "PENDING" } }),
            prisma.documentBackup.count({ where: { organizationId, status: "ERROR" } }),
            prisma.documentBackup.count({ where: { organizationId, status: "DONE" } }),
        ]);
        return { conn, pending, failed, done, configured: Boolean(driveOAuthConfig() && driveTokenKey()) };
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const { conn, pending, failed, done, configured } = guard.data;
    return (
        <div className="container stack-lg" style={{ maxWidth: "720px" }}>
            <div>
                <Link href="/settings" style={{ color: "var(--secondary)", fontSize: "0.875rem" }}>&larr; Configuración</Link>
                <h1>Respaldo en Google Drive</h1>
                <p className="muted">Cada comprobante que se carga en el sistema se guarda en Drive con nombre estándar, en la carpeta del cliente, el impuesto y el período.</p>
            </div>
            {sp.ok && <p role="status">Google Drive quedó conectado.</p>}
            {sp.error && <p role="alert">{ERRORS[sp.error] ?? "No se pudo conectar."}</p>}
            <section className="card stack">
                {!configured && <p role="alert">Falta cargar en Netlify las variables GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET y DRIVE_TOKEN_KEY.</p>}
                {conn ? (
                    <>
                        <p>Conectado con <strong>{conn.email ?? "cuenta de Google"}</strong> desde el {conn.connectedAt.toISOString().slice(0, 10).split("-").reverse().join("/")}.</p>
                        <p>Carpeta raíz: <strong>Mi unidad / {conn.rootFolderName}</strong></p>
                        <div style={{ display: "flex", gap: "var(--spacing-sm)", flexWrap: "wrap" }}>
                            <a className="btn btn-secondary" href="/api/drive/connect">Volver a conectar</a>
                            <DisconnectDriveButton />
                        </div>
                    </>
                ) : (
                    <>
                        <p>Todavía no hay una cuenta conectada. Los comprobantes cargados quedan en cola y se suben cuando se conecte.</p>
                        {configured && <a className="btn btn-primary" href="/api/drive/connect" style={{ justifySelf: "start" }}>Conectar Google Drive</a>}
                    </>
                )}
                <p>Respaldos: {done} subidos · {pending} pendientes · {failed} con error.</p>
            </section>
        </div>
    );
}
