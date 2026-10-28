"use client";

import { ClientProfileForm, type ClientProfileInitial } from "../_components/client-profile-form";
import { LEGACY_INITIAL_IIBB_RATE } from "@/lib/legacy-iibb-rate";

// Alta de cliente: contactos obligatorios; inscripción IIBB sin opción
// preseleccionada (vacía = sin clasificar). La alícuota del cálculo heredado se
// MUESTRA (sólo lectura) con el valor inicial que aplica la API cuando no se
// envía; el formulario no la envía.
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

export default function NewClientPage() {
    return <ClientProfileForm mode="create" initial={EMPTY} />;
}
