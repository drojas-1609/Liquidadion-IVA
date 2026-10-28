/**
 * ARCA — WSAA (Web Service de Autenticación y Autorización), operación
 * `loginCms`.
 *
 * Fuentes: https://www.afip.gob.ar/ws/documentacion/wsaa.asp y WSDL público
 * (`loginCms(in0: string) -> loginCmsReturn: string`, namespace
 * `http://wsaa.view.sua.dvadac.desein.afip.gov`).
 *
 * Flujo: se arma un TRA (loginTicketRequest) para el servicio de negocio, se
 * FIRMA como CMS (PKCS#7) con el certificado X.509 emitido por ARCA y su clave
 * privada, y se envía en base64. La respuesta (loginTicketResponse, XML
 * escapado dentro de loginCmsReturn) trae `token`, `sign` y `expirationTime`.
 *
 * La firma CMS se delega en un `CmsSigner` (ver config.ts): este módulo nunca
 * ve la clave privada. Puro: sin red ni registros.
 */
import { child, childText, escapeXml, parseXml, XmlParseError, soapBody, soapFault } from "./xml";
import type { ArcaEnvironment } from "./padron";

export const WSAA_ENDPOINTS: Readonly<Record<ArcaEnvironment, string>> = {
    homologacion: "https://wsaahomo.afip.gov.ar/ws/services/LoginCms",
    produccion: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
};
export const WSAA_NAMESPACE = "http://wsaa.view.sua.dvadac.desein.afip.gov";

/** Firma el TRA como CMS (PKCS#7, contenido adjunto) y devuelve el DER en base64. */
export type CmsSigner = (traXml: string) => Promise<string>;

export interface WsaaTicket {
    token: string;
    sign: string;
    /** Instante de vencimiento (epoch ms). */
    expiresAt: number;
}

/** ISO 8601 con zona: el formato que acepta el TRA. */
function isoWithOffset(ms: number): string {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function buildLoginTicketRequest(args: { service: string; nowMs: number; uniqueId: number }): string {
    if (!/^[a-z0-9_]+$/.test(args.service)) throw new Error("servicio inválido");
    return (
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<loginTicketRequest version="1.0"><header>` +
        `<uniqueId>${Math.trunc(args.uniqueId)}</uniqueId>` +
        `<generationTime>${isoWithOffset(args.nowMs - 60_000)}</generationTime>` +
        `<expirationTime>${isoWithOffset(args.nowMs + 12 * 60 * 60_000)}</expirationTime>` +
        `</header><service>${escapeXml(args.service)}</service></loginTicketRequest>`
    );
}

export function buildLoginCmsRequest(cmsBase64: string): string {
    if (!/^[A-Za-z0-9+/=\s]+$/.test(cmsBase64)) throw new Error("CMS inválido");
    return (
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="${WSAA_NAMESPACE}">` +
        `<soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cmsBase64.replace(/\s+/g, "")}</wsaa:in0></wsaa:loginCms>` +
        `</soapenv:Body></soapenv:Envelope>`
    );
}

export type LoginCmsParse = { kind: "TICKET"; ticket: WsaaTicket } | { kind: "FAULT" } | { kind: "INVALID" };

/** Normaliza la respuesta de loginCms. Nunca devuelve el texto del fault. */
export function parseLoginCmsResponse(xml: string): LoginCmsParse {
    try {
        const doc = parseXml(xml);
        const body = soapBody(doc);
        if (!body) return { kind: "INVALID" };
        if (soapFault(doc)) return { kind: "FAULT" };
        const response=body.children[0];
        if(body.children.length!==1 || response?.name!=="loginCmsResponse" || response.namespaceUri!==WSAA_NAMESPACE)return {kind:"INVALID"};
        const ret = child(response, "loginCmsReturn");
        if (!ret || ret.text.trim() === "") return { kind: "INVALID" };
        const inner = parseXml(ret.text.trim());
        if (inner.name !== "loginTicketResponse") return { kind: "INVALID" };
        const credentials = child(inner, "credentials");
        const token = childText(credentials, "token");
        const sign = childText(credentials, "sign");
        const expiration = childText(child(inner, "header"), "expirationTime");
        const expiresAt = expiration === null ? NaN : Date.parse(expiration);
        if (!token || !sign || !Number.isFinite(expiresAt)) return { kind: "INVALID" };
        return { kind: "TICKET", ticket: { token, sign, expiresAt } };
    } catch (err) {
        if (err instanceof XmlParseError) return { kind: "INVALID" };
        throw err;
    }
}

/** Un ticket se reutiliza mientras le queden más de 1 minuto. */
export const TICKET_SAFETY_MS = 60_000;

export function ticketUsable(ticket: WsaaTicket | null, nowMs: number): ticket is WsaaTicket {
    return ticket !== null && ticket.expiresAt - TICKET_SAFETY_MS > nowMs;
}
