"use client";

import { ClientProfileForm, type ClientProfileInitial } from "../_components/client-profile-form";

// Alta de cliente: contactos obligatorios; inscripción IIBB sin opción
// preseleccionada (vacía = sin clasificar); alícuota del cálculo actual con el
// valor por defecto vigente (3).
const EMPTY: ClientProfileInitial = {
    name: "",
    cuit: "",
    condition: "Responsable Inscripto",
    address: "",
    defaultIibbRate: "3.0",
    phone: "",
    contactEmail: "",
    iibbRegistration: null,
    jurisdictions: [],
    activities: [],
};

export default function NewClientPage() {
    return <ClientProfileForm mode="create" initial={EMPTY} />;
}
