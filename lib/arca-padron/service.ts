import "server-only";
import {LookupFailure,postSoap} from "./http";
import {postgresTicketStore,type SharedTicketStore} from "./ticket-store";
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
    ticketCache: { get(): WsaaTicket | null; set(t: WsaaTicket): void; clear?(ticket:WsaaTicket):void };
    ticketStore?: SharedTicketStore;
}

export const ARCA_TIMEOUT_MS = 8_000;
export function defaultLookupDeps(): LookupDeps {
    const config=readArcaConfig();
    // Ninguna ruta de producción usa una caché en memoria como sustituto del almacén compartido.
    const base:LookupDeps={fetchImpl:fetch,config,nowMs:Date.now,timeoutMs:ARCA_TIMEOUT_MS,ticketCache:{get:()=>null,set:()=>{throw new LookupFailure("AUTH");}}};
    if(config.configured){
        if(!config.ticketScope||!config.cacheKey)return {...base,config:{configured:false,reason:"MISSING_SETTINGS",missing:["ARCA_WSAA_CACHE_KEY"]}};
        base.ticketStore=postgresTicketStore(config.ticketScope,config.cacheKey);
    }
    return base;
}

async function ticketFor(deps: LookupDeps, config: Extract<ArcaConfigStatus, { configured: true }>): Promise<WsaaTicket> {
    const now = deps.nowMs();
    if(deps.ticketStore)return deps.ticketStore.getOrIssue(()=>issueTicket(deps,config));
    const cached = deps.ticketCache.get();
    if (ticketUsable(cached, now)) return cached;
    const issued=await issueTicket(deps,config);deps.ticketCache.set(issued);return issued;
}

async function issueTicket(deps:LookupDeps,config:Extract<ArcaConfigStatus,{configured:true}>):Promise<WsaaTicket>{
    const now=deps.nowMs();
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
    if(!ticketUsable(parsed.ticket,deps.nowMs()))throw new LookupFailure("INVALID_RESPONSE");
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
        if (parsed.kind === "AUTH") {
            if(deps.ticketStore)await deps.ticketStore.invalidate(ticket);
            else deps.ticketCache.clear?.(ticket);
            return {status:"ERROR",code:"AUTH"};
        }
        if (parsed.kind === "FAULT") return { status: "ERROR", code: "UNAVAILABLE" };
        if (parsed.kind === "INVALID") return { status: "ERROR", code: "INVALID_RESPONSE" };
        const consultedAt = new Date(deps.nowMs()).toISOString();
        return { status: "FOUND", cuit: cuit.value, source: PADRON_SOURCE_LABEL, consultedAt, person: parsed.person };
    } catch (err) {
        if (err instanceof LookupFailure) return { status: "ERROR", code: err.code };
        return { status: "ERROR", code: "UNAVAILABLE" };
    }
}
