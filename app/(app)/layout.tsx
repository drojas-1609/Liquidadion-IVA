import Image from "next/image";
import { cookies } from "next/headers";
import { NavLink } from "./_components/nav-link";
import { ClientMenu } from "./_components/client-menu";
import { ClientSwitcher } from "./_components/client-switcher";
import { loadSidebarData, ACTIVE_CLIENT_COOKIE } from "@/lib/navigation/sidebar-data";

import { getAuthClaims } from "@/lib/auth/claims";

/**
 * Shell autenticado (barra lateral + <main>). Vive en el route group `(app)`
 * para que SOLO lo compartan las páginas protegidas por `proxy.ts`. Las
 * páginas públicas de auth (/login, /reset-password, /update-password,
 * /auth/confirm-recovery) quedan fuera del grupo y se renderizan únicamente
 * con el layout raíz, sin barra lateral.
 */
export default async function AppShellLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Etapa 3A: si Supabase todavía no está configurado localmente, la app
  // sigue renderizando sin sesión.
  let userLabel: string | null = null;
  try {
    const claims = await getAuthClaims();
    userLabel = claims ? claims.email ?? claims.sub : null;
  } catch {
    userLabel = null;
  }
  // Menú por módulos y selector de cliente (sin sesión o sin acceso: null).
  const nav = userLabel ? await loadSidebarData() : null;
  let rememberedId: string | null = null;
  try {
    rememberedId = nav ? (await cookies()).get(ACTIVE_CLIENT_COOKIE)?.value ?? null : null;
  } catch {
    rememberedId = null;
  }

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-brand">
          <span className="app-brand-mark"><Image src="/branding/dero-company-isotipo.png" alt="" width={146} height={140} priority /></span>
          <span>
            <strong>Dero Company</strong>
            <small>Gestión</small>
          </span>
        </div>
        <nav className="app-nav" aria-label="Secciones">
          <NavLink href="/">Dashboard</NavLink>
          <NavLink href="/clients">Clientes</NavLink>
          <NavLink href="/settings">Configuración</NavLink>
        </nav>
        {nav && nav.clients.length > 0 && <ClientMenu clients={nav.clients} hasIva={nav.hasIva} rememberedId={rememberedId} />}
        {userLabel && (
          <div className="app-user">
            <p title={userLabel}>{userLabel}</p>
            <form method="post" action="/logout">
              <button type="submit" className="btn btn-secondary btn-sm" style={{ width: "100%" }}>
                Cerrar sesión
              </button>
            </form>
          </div>
        )}
      </aside>
      {/* Espacio inferior: el último control (p. ej. «Confirmar importación») puede
          desplazarse por encima de barras flotantes (en las Deploy Previews, la de
          Netlify lo tapaba y el clic no llegaba a la página: SMOKE-PREVIEW.md). */}
      <main className="app-main">
        {nav && nav.clients.length > 0 && (
          <div className="app-topbar">
            <ClientSwitcher clients={nav.clients} rememberedId={rememberedId} />
          </div>
        )}
        {process.env.ARCA_LOCAL_HOMO==='1'&&<p role="status" style={{padding:"1rem",border:"1px solid var(--primary)",marginBottom:"1rem"}}>Prueba local · ARCA homologación · DEV. Guardar y modificar datos está deshabilitado. Los datos propuestos quedan sólo en el formulario.</p>}
        {children}
      </main>
    </div>
  );
}
