import { ClientProfileForm, type ClientProfileInitial } from "../_components/client-profile-form";
import { LEGACY_INITIAL_IIBB_RATE } from "@/lib/legacy-iibb-rate";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    requireAllClientsScope,
    guardPage,
} from "@/lib/auth/authz";
import { ROLES_CLIENT_CREATE, ROLES_CONFIG } from "@/lib/auth/roles";
import { AccessNotice } from "@/app/_components/access-notice";

export const dynamic = "force-dynamic";

// Alta de cliente: contactos obligatorios; inscripción IIBB sin opción
// preseleccionada (vacía = sin clasificar). La alícuota del cálculo heredado se
// MUESTRA (sólo lectura) con el valor inicial que aplica la API cuando no se
// envía; el formulario no la envía.
//
// Mismos permisos que POST /api/clients: rol de alta, módulo Fichas de
// clientes y alcance "todos los clientes" (la API vuelve a verificarlo).
const EMPTY: ClientProfileInitial = {
    name: "",
    cuit: "",
    condition: "Responsable Inscripto",
    address: "",
    defaultIibbRate: LEGACY_INITIAL_IIBB_RATE,
    phone: "",
    contactEmail: "",
    iibbRegistration: null,
    jurisdictions: [],
    activities: [],
};

export default async function NewClientPage() {
    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId } = await resolveActiveOrganization(profileId);
        const access = await requireOrganizationRole(profileId, organizationId, ROLES_CLIENT_CREATE, { module: "CLIENTS" });
        requireAllClientsScope(access);
        return ROLES_CONFIG.includes(access.role);
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    return <ClientProfileForm mode="create" initial={EMPTY} canManageArca={guard.data} />;
}
