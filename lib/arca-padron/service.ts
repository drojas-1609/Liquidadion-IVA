import "server-only";
import { normalizeCuit } from "../cuit";
import { readArcaConfig, type ArcaConfigStatus } from "./config";
import {
    buildGetPersonaV2Request,
    PADRON_ENDPOINTS,
    PADRON_SERVICE,
    PADRON_SOURCE_LABEL,
    parseGetPersonaV2Response,
    type PadronPerson,
} from "./padron";
import {
    buildLoginCmsRequest,
    buildLoginTicketRequest,
    parseLoginCmsResponse,
    ticketUsable,
    WSAA_ENDPOINTS,
    type WsaaTicket,
} from "./wsaa";

/**
 * Consulta de un CUIT en ARCA (servidor). Encadena: configuración -> ticket
 * WSAA (cacheado mientras sea válido) -> getPersona_v2 con timeout ->
 * normalización. No crea ni modifica clientes, no persiste la respuesta y no
 * registra CUIT, tickets, certificados ni respuestas: los errores se reducen a
 * un código.
 */

export type CuitLookupResult =
    | { status: "FOUND"; cuit: string; source: string; consultedAt: string; person: PadronPerson }
    | { status: "NOT_FOUND"; cuit: string }
    | { status: "NOT_CONFIGURED" }
    | { status: "INVALID_CUIT"; error: string }
    | { status: "ERROR"; code: "TIMEOUT" | "UNAVAILABLE" | "AUTH" | "INVALID_RESPONSE" };

export interface LookupDeps {
    fetchImpl: typeof fetch;
    config: ArcaConfigStatus;
    nowMs: () => number;
    timeoutMs: number;
    ticketCache: { get(): WsaaTicket | null; set(t: WsaaTicket): void };
}

let cachedTicket: WsaaTicket | null = null;
const processTicketCache = { get: () => cachedTicket, set: (t: WsaaTicket) => void (cachedTicket = t) };

export const ARCA_TIMEOUT_MS = 8_000;

export function defaultLookupDeps(): LookupDeps {
    return { fetchImpl: fetch, config: readArcaConfig(), nowMs: Date.now, timeoutMs: ARCA_TIMEOUT_MS, ticketCache: processTicketCache };
}

class LookupFailure extends Error {
    constructor(readonly code: "TIMEOUT" | "UNAVAILABLE" | "AUTH" | "INVALID_RESPONSE") {
        super(code);
    }
}

async function postSoap(deps: LookupDeps, url: string, body: string, action: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
    try {
        const res = await deps.fetchImpl(url, {
            method: "POST",
            headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: action },
            body,
            signal: controller.signal,
            cache: "no-store",
        });
        const text = await res.text();
        // Un fault SOAP llega como 500 con cuerpo XML: lo interpreta el parser.
        if (!res.ok && !text.includes("Fault")) throw new LookupFailure("UNAVAILABLE");
        return text;
    } catch (err) {
        if (err instanceof LookupFailure) throw err;
        if (err instanceof Error && err.name === "AbortError") throw new LookupFailure("TIMEOUT");
        throw new LookupFailure("UNAVAILABLE");
    } finally {
        clearTimeout(timer);
    }
}

async function ticketFor(deps: LookupDeps, config: Extract<ArcaConfigStatus, { configured: true }>): Promise<WsaaTicket> {
    const now = deps.nowMs();
    const cached = deps.ticketCache.get();
    if (ticketUsable(cached, now)) return cached;
    let cms: string;
    try {
        cms = await config.signer(buildLoginTicketRequest({ service: PADRON_SERVICE, nowMs: now, uniqueId: Math.floor(now / 1000) }));
    } catch {
        throw new LookupFailure("AUTH");
    }
    const xml = await postSoap(deps, WSAA_ENDPOINTS[config.environment], buildLoginCmsRequest(cms), "");
    const parsed = parseLoginCmsResponse(xml);
    if (parsed.kind === "FAULT") throw new LookupFailure("AUTH");
    if (parsed.kind === "INVALID") throw new LookupFailure("INVALID_RESPONSE");
    deps.ticketCache.set(parsed.ticket);
    return parsed.ticket;
}

export async function lookupCuit(cuitInput: unknown, deps: LookupDeps = defaultLookupDeps()): Promise<CuitLookupResult> {
    const cuit = normalizeCuit(cuitInput);
    if (!cuit.ok) return { status: "INVALID_CUIT", error: cuit.error };
    if (!deps.config.configured) return { status: "NOT_CONFIGURED" };
    const config = deps.config;
    const idPersona = cuit.value.replace(/-/g, "");

    try {
        const ticket = await ticketFor(deps, config);
        const xml = await postSoap(
            deps,
            PADRON_ENDPOINTS[config.environment],
            buildGetPersonaV2Request({ token: ticket.token, sign: ticket.sign, cuitRepresentada: config.cuitRepresentada, idPersona }),
            "",
        );
        const parsed = parseGetPersonaV2Response(xml, idPersona);
        if (parsed.kind === "NOT_FOUND") return { status: "NOT_FOUND", cuit: cuit.value };
        if (parsed.kind === "FAULT") return { status: "ERROR", code: "UNAVAILABLE" };
        if (parsed.kind === "INVALID") return { status: "ERROR", code: "INVALID_RESPONSE" };
        const consultedAt = new Date(deps.nowMs()).toISOString();
        return { status: "FOUND", cuit: cuit.value, source: PADRON_SOURCE_LABEL, consultedAt, person: parsed.person };
    } catch (err) {
        if (err instanceof LookupFailure) return { status: "ERROR", code: err.code };
        return { status: "ERROR", code: "UNAVAILABLE" };
    }
}
