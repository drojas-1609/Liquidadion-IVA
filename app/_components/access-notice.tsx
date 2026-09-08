import Link from "next/link";
import type { PageAccessNoticeKind } from "@/lib/auth/authz";

/**
 * Aviso mínimo para páginas SSR cuando la guarda de autorización devuelve un
 * estado que NO es "redirigir al login" ni "404": el usuario tiene sesión pero
 * no puede ver contenido fiscal (sin Profile, sin organización, más de una
 * organización sin selector, rol insuficiente, o servicio de auth caído).
 *
 * NO revela nada de otra organización: el usuario ya es (o no) miembro.
 */
const MESSAGES: Record<PageAccessNoticeKind, { title: string; body: string }> = {
    "no-profile": {
        title: "Acceso no habilitado",
        body: "Tu usuario todavía no está habilitado en la aplicación. Pedile a un administrador que te dé acceso.",
    },
    "no-organization": {
        title: "Sin organización",
        body: "Tu usuario no pertenece a ninguna organización.",
    },
    "org-selection": {
        title: "Elegí una organización",
        body: "Tu usuario pertenece a más de una organización. La selección de organización todavía no está disponible.",
    },
    forbidden: {
        title: "Sin permisos",
        body: "No tenés permisos para ver esta sección de tu organización.",
    },
    misconfigured: {
        title: "Servicio no disponible",
        body: "El servicio de autenticación no está disponible en este momento. Probá de nuevo más tarde.",
    },
};

export function AccessNotice({ notice }: { notice: PageAccessNoticeKind }) {
    const m = MESSAGES[notice];
    return (
        <div className="container" style={{ maxWidth: "560px" }}>
            <div className="card">
                <h1 style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>
                    {m.title}
                </h1>
                <p style={{ color: "var(--secondary)" }}>{m.body}</p>
                <div style={{ marginTop: "var(--spacing-lg)" }}>
                    <Link href="/" className="btn btn-secondary">
                        Volver al inicio
                    </Link>
                </div>
            </div>
        </div>
    );
}
