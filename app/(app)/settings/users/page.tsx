import Link from "next/link";
import { guardPage } from "@/lib/auth/authz";
import { AccessNotice } from "@/app/_components/access-notice";
import { requireUsersManager } from "@/lib/users/route-authz";
import { loadUsersOverview } from "@/lib/users/service";
import { UsersManager } from "./users-manager";

export const dynamic = "force-dynamic";

// Configuración → Usuarios. SÓLO el propietario (requireUsersManager relee la
// Membership en cada solicitud). Sin datos de otros estudios.
export default async function UsersSettingsPage() {
    const guard = await guardPage(async () => {
        const actor = await requireUsersManager();
        return loadUsersOverview(actor);
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;

    return (
        <div className="container" style={{ maxWidth: "1100px" }}>
            <div style={{ marginBottom: "var(--spacing-lg)" }}>
                <Link href="/settings" style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-xs)", display: "inline-block" }}>
                    &larr; Volver a Configuración
                </Link>
                <h1 style={{ fontSize: "2rem", fontWeight: "bold" }}>Usuarios</h1>
                <p style={{ color: "var(--secondary)" }}>
                    Invitá personas del estudio y definí, por separado, su rol, los clientes que ven y los módulos que usan.
                </p>
            </div>
            <UsersManager overview={guard.data} />
        </div>
    );
}
