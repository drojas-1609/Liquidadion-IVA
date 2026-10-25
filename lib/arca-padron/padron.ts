/**
 * ARCA — Consulta a Padrón Constancia de Inscripción (WSN
 * `ws_sr_constancia_inscripcion`, ex Alcance 5), operación `getPersona_v2`.
 *
 * Fuente: WSDL oficial publicado por ARCA
 *   homologación: https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5?WSDL
 *   producción:   https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5?WSDL
 * (namespace `http://a5.soap.ws.server.puc.sr/`; entrada token, sign,
 * cuitRepresentada, idPersona; salida personaReturn con datosGenerales,
 * datosRegimenGeneral, datosMonotributo, errorConstancia y metadata).
 *
 * Este módulo es PURO: arma el request y normaliza la respuesta. No hace red,
 * no registra nada y no conserva la respuesta completa: sólo extrae los datos
 * que la ficha puede proponer (nombre, domicilio fiscal, impuestos/regímenes
 * informados y actividades con su nomenclador de ARCA).
 */
import { child, childText, childrenNamed, escapeXml, find, parseXml, XmlParseError, type XmlElement } from "./xml";

export const PADRON_SERVICE = "ws_sr_constancia_inscripcion";
export const PADRON_NAMESPACE = "http://a5.soap.ws.server.puc.sr/";
export const PADRON_SOURCE_LABEL = "ARCA — Padrón Constancia de Inscripción (ws_sr_constancia_inscripcion)";

export const PADRON_ENDPOINTS = {
    homologacion: "https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5",
    produccion: "https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5",
} as const;
export type ArcaEnvironment = keyof typeof PADRON_ENDPOINTS;

export function buildGetPersonaV2Request(args: {
    token: string;
    sign: string;
    cuitRepresentada: string;
    idPersona: string;
}): string {
    for (const v of [args.cuitRepresentada, args.idPersona]) {
        if (!/^\d{11}$/.test(v)) throw new Error("CUIT inválido para la consulta");
    }
    return (
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="${PADRON_NAMESPACE}">` +
        `<soapenv:Header/><soapenv:Body><a5:getPersona_v2>` +
        `<token>${escapeXml(args.token)}</token>` +
        `<sign>${escapeXml(args.sign)}</sign>` +
        `<cuitRepresentada>${args.cuitRepresentada}</cuitRepresentada>` +
        `<idPersona>${args.idPersona}</idPersona>` +
        `</a5:getPersona_v2></soapenv:Body></soapenv:Envelope>`
    );
}

export interface PadronActivity {
    /** idActividad: código de actividad en el nomenclador de ARCA (NO es NAES ni provincial). */
    code: string;
    description: string;
    /** Número de nomenclador informado por ARCA (campo `nomenclador`). */
    nomenclator: string | null;
    order: number | null;
    period: string | null;
}

export interface PadronTax {
    id: string;
    description: string;
    status: string | null;
}

export interface PadronPerson {
    /** CUIT consultado, 11 dígitos. */
    idPersona: string;
    /** Razón social o "Apellido Nombre", tal como lo entrega ARCA. */
    name: string | null;
    personType: string | null;
    keyStatus: string | null;
    fiscalAddress: {
        street: string | null;
        locality: string | null;
        postalCode: string | null;
        /** Provincia según ARCA (idProvincia del padrón: NO es el código de Convenio Multilateral). */
        provinceArcaId: string | null;
        provinceName: string | null;
    } | null;
    taxes: PadronTax[];
    monotributoCategory: string | null;
    activities: PadronActivity[];
    /** Mensajes de errorConstancia / errorRegimenGeneral / errorMonotributo (texto de ARCA). */
    notices: string[];
    /** metadata.fechaHora informada por ARCA (ISO), si vino. */
    sourceDateTime: string | null;
}

export type PadronParse =
    | { kind: "FOUND"; person: PadronPerson }
    | { kind: "NOT_FOUND" }
    | { kind: "FAULT" }
    | { kind: "INVALID" };

const NOT_FOUND_RE = /no\s+existe\s+persona/i;
const MAX_NOTICES = 5;
const MAX_TEXT = 300;

function clip(s: string | null): string | null {
    return s === null ? null : s.slice(0, MAX_TEXT);
}

function activitiesOf(nodes: XmlElement[]): PadronActivity[] {
    return nodes
        .map((a) => ({
            code: childText(a, "idActividad") ?? "",
            description: clip(childText(a, "descripcionActividad")) ?? "",
            nomenclator: childText(a, "nomenclador"),
            order: childText(a, "orden") === null ? null : Number(childText(a, "orden")),
            period: childText(a, "periodo"),
        }))
        .filter((a) => /^\d{1,12}$/.test(a.code) && a.description !== "");
}

function taxesOf(el: XmlElement | undefined): PadronTax[] {
    return childrenNamed(el, "impuesto")
        .map((t) => ({
            id: childText(t, "idImpuesto") ?? "",
            description: clip(childText(t, "descripcionImpuesto")) ?? "",
            status: childText(t, "estadoImpuesto"),
        }))
        .filter((t) => t.id !== "" && t.description !== "");
}

function noticesOf(...els: Array<XmlElement | undefined>): string[] {
    const out: string[] = [];
    for (const el of els) {
        for (const e of childrenNamed(el, "error")) {
            const t = e.text.trim();
            if (t) out.push(t.slice(0, MAX_TEXT));
        }
        const msg = childText(el, "mensaje");
        if (msg) out.push(msg.slice(0, MAX_TEXT));
    }
    return [...new Set(out)].slice(0, MAX_NOTICES);
}

/**
 * Normaliza la respuesta SOAP de getPersona_v2 para el CUIT consultado. Una
 * respuesta que no corresponde a ese CUIT, o sin estructura reconocible, es
 * INVALID (nunca se proponen datos de otra persona).
 */
export function parseGetPersonaV2Response(xml: string, expectedIdPersona: string): PadronParse {
    let doc: XmlElement;
    try {
        doc = parseXml(xml);
    } catch (err) {
        if (err instanceof XmlParseError) return { kind: "INVALID" };
        throw err;
    }
    if (doc.name !== "Envelope") return { kind: "INVALID" };
    const body = child(doc, "Body");
    if (!body) return { kind: "INVALID" };

    const fault = child(body, "Fault");
    if (fault) {
        const text = `${childText(fault, "faultstring") ?? ""} ${find(fault, "detail")?.text ?? ""}`;
        return NOT_FOUND_RE.test(text) ? { kind: "NOT_FOUND" } : { kind: "FAULT" };
    }

    const response = child(body, "getPersona_v2Response");
    if (!response) return { kind: "INVALID" };
    const ret = child(response, "personaReturn");
    if (!ret) return { kind: "NOT_FOUND" };

    const generales = child(ret, "datosGenerales");
    const errorConstancia = child(ret, "errorConstancia");
    const regimen = child(ret, "datosRegimenGeneral");
    const mono = child(ret, "datosMonotributo");
    const notices = noticesOf(errorConstancia, child(ret, "errorRegimenGeneral"), child(ret, "errorMonotributo"));

    const idPersona = childText(generales, "idPersona") ?? childText(errorConstancia, "idPersona");
    if (idPersona === null) {
        return notices.some((m) => NOT_FOUND_RE.test(m)) ? { kind: "NOT_FOUND" } : { kind: "INVALID" };
    }
    if (idPersona !== expectedIdPersona) return { kind: "INVALID" };
    if (!generales) return notices.some((m) => NOT_FOUND_RE.test(m)) ? { kind: "NOT_FOUND" } : { kind: "INVALID" };

    const razonSocial = childText(generales, "razonSocial");
    const apellido = childText(generales, "apellido");
    const nombre = childText(generales, "nombre");
    const name = razonSocial ?? ([apellido, nombre].filter(Boolean).join(" ") || null);

    const dom = child(generales, "domicilioFiscal");
    const fiscalAddress = dom
        ? {
              street: clip(childText(dom, "direccion")),
              locality: clip(childText(dom, "localidad")),
              postalCode: clip(childText(dom, "codPostal")),
              provinceArcaId: childText(dom, "idProvincia"),
              provinceName: clip(childText(dom, "descripcionProvincia")),
          }
        : null;

    const activities = activitiesOf([
        ...childrenNamed(regimen, "actividad"),
        ...childrenNamed(mono, "actividad"),
        ...childrenNamed(mono, "actividadMonotributista"),
    ]);
    const uniqueActivities = activities.filter(
        (a, idx) => activities.findIndex((b) => b.code === a.code && b.nomenclator === a.nomenclator) === idx,
    );

    return {
        kind: "FOUND",
        person: {
            idPersona,
            name: clip(name),
            personType: childText(generales, "tipoPersona"),
            keyStatus: childText(generales, "estadoClave"),
            fiscalAddress,
            taxes: [...taxesOf(regimen), ...taxesOf(mono)],
            monotributoCategory: clip(childText(child(mono, "categoriaMonotributo"), "descripcionCategoria")),
            activities: uniqueActivities,
            notices,
            sourceDateTime: childText(child(ret, "metadata"), "fechaHora"),
        },
    };
}
