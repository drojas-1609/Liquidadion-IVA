import "server-only";
import { arcaHomoRuntimeEligible, ARCA_HOMO_EXAMPLE_CUIT } from "./preview-gate";
import {LookupFailure,postSoap} from "./http";
import {postgresTicketStore,TicketStoreFailure,TicketUnavailable,type SharedTicketStore} from "./ticket-store";
import { arcaProdRuntimeEligible } from "./production-gate";
import { readQuotaConfig, type QuotaConfig } from "./quota-store";
import { normalizeCuit } from "../cuit";
import { readArcaConfig, type ArcaConfigStatus } from "./config";
import {
    buildGetPersonaV2Request,
    PADRON_ENDPOINTS,
    PADRON_HOMO_AFIP_ENDPOINT,
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
    /** Sin ticket utilizable y todavía no corresponde pedir otro (instante fijo del almacén). */
    | { status: "RETRY_LATER"; retryAfterSeconds: number }
    | { status: "ERROR"; code: "TIMEOUT" | "UNAVAILABLE" | "AUTH" | "INVALID_RESPONSE" | "STORE_UNAVAILABLE" };

export interface LookupDeps {
    fetchImpl: typeof fetch;
    config: ArcaConfigStatus;
    nowMs: () => number;
    timeoutMs: number;
    ticketCache: { get(): WsaaTicket | null; set(t: WsaaTicket): void; clear?(ticket:WsaaTicket):void };
    ticketStore?: SharedTicketStore;
    allowedCuits?: readonly string[];
    homologationTransport?: "afip-wsdl";
    /** Sólo producción: el llamador exige interruptor, habilitación de la organización y cupos compartidos. */
    production?: { quotas: QuotaConfig; certificateKey: string };
}

export const ARCA_TIMEOUT_MS = 8_000;
const DISABLED:ArcaConfigStatus={configured:false,reason:"DISABLED",missing:[]};
export function defaultLookupDeps(env:Readonly<Record<string,string|undefined>>=process.env,nowMs:()=>number=Date.now): LookupDeps {
    // Barreras separadas: homologación (Preview / ensayo local) o producción; nunca ambas.
    // Las constantes de build se leen de process.env para que Next las inlinee.
    const homo=arcaHomoRuntimeEligible(env,process.env.ARCA_HOMO_BUILD_ELIGIBLE,nowMs());
    const gate = homo ? null : arcaProdRuntimeEligible(
        env, process.env.ARCA_PROD_BUILD_ELIGIBLE, process.env.ARCA_HOMO_BUILD_ELIGIBLE, process.env.NODE_ENV, nowMs(),
    );
    const prod = gate?.ok === true;
    const diagnose = (reason: string) => {
        if (env === process.env && process.env.NODE_ENV === "production" && env.ARCA_PADRON_ENABLED === "true" && !homo) {
            console.warn("[arca-production] lookup blocked", reason);
        }
    };
    const quotas=prod?readQuotaConfig(env):null;
    const config:ArcaConfigStatus=homo||(prod&&quotas)?readArcaConfig(env):DISABLED;
    // Ninguna ruta usa una caché en memoria como sustituto del almacén compartido.
    const base:LookupDeps={fetchImpl:fetch,config,nowMs,timeoutMs:ARCA_TIMEOUT_MS,ticketCache:{get:()=>null,set:()=>{throw new LookupFailure("AUTH");}}};
    if (!config.configured) {
        diagnose(gate && !gate.ok ? gate.reason : prod && !quotas ? "QUOTA_CONFIG" : config.reason);
        return base;
    }
    if(!config.ticketScope||!config.cacheKeys)return {...base,config:{configured:false,reason:"MISSING_SETTINGS",missing:["ARCA_WSAA_CACHE_KEY"]}};
    if(config.environment!==(homo?"homologacion":"produccion"))return {...base,config:DISABLED};
    try{base.ticketStore=postgresTicketStore(config.ticketScope,config.cacheKeys);}catch{return {...base,config:DISABLED};}
    if(homo){
        base.allowedCuits=[config.cuitRepresentada,ARCA_HOMO_EXAMPLE_CUIT];
        base.homologationTransport="afip-wsdl";
    }else base.production={quotas:quotas!,certificateKey:config.ticketScope};
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
    if(deps.allowedCuits&&!deps.allowedCuits.includes(idPersona))return {status:"INVALID_CUIT",error:"La prueba de homologación sólo admite el CUIT titular o el ejemplo del manual de ARCA."};
    if(deps.homologationTransport&&config.environment!=="homologacion")return {status:"NOT_CONFIGURED"};

    let stage: "WSAA_OR_TICKET" | "PADRON" = "WSAA_OR_TICKET";
    try {
        const ticket = await ticketFor(deps, config);
        stage = "PADRON";
        const xml = await postSoap(
            deps,
            deps.homologationTransport==="afip-wsdl"?PADRON_HOMO_AFIP_ENDPOINT:PADRON_ENDPOINTS[config.environment],
            buildGetPersonaV2Request({ token: ticket.token, sign: ticket.sign, cuitRepresentada: config.cuitRepresentada, idPersona }),
            "",
        );
        const parsed = parseGetPersonaV2Response(xml, idPersona);
        if (parsed.kind === "NOT_FOUND") return { status: "NOT_FOUND", cuit: cuit.value };
        if (parsed.kind === "AUTH") {
            // Se conserva el ticket: queda sin uso hasta su vencimiento (no se fuerza otra autenticación).
            if(deps.ticketStore)await deps.ticketStore.reject(ticket).catch(()=>{});
            else deps.ticketCache.clear?.(ticket);
            return {status:"ERROR",code:"AUTH"};
        }
        if (parsed.kind === "FAULT") {
            if (deps.production) console.warn("[arca-production] lookup failed", { stage, kind: "SOAP_FAULT" });
            return { status: "ERROR", code: "UNAVAILABLE" };
        }
        if (parsed.kind === "INVALID") return { status: "ERROR", code: "INVALID_RESPONSE" };
        const consultedAt = new Date(deps.nowMs()).toISOString();
        return { status: "FOUND", cuit: cuit.value, source: PADRON_SOURCE_LABEL, consultedAt, person: parsed.person };
    } catch (err) {
        if (err instanceof LookupFailure) {
            if (deps.production) console.warn("[arca-production] lookup failed", { stage, kind: err.code, ...err.diagnostic });
            return { status: "ERROR", code: err.code };
        }
        if (err instanceof TicketUnavailable) return { status: "RETRY_LATER", retryAfterSeconds: Math.max(1, Math.ceil((err.retryAt - deps.nowMs()) / 1000)) };
        if (err instanceof TicketStoreFailure) return { status: "ERROR", code: "STORE_UNAVAILABLE" };
        if (deps.production) console.warn("[arca-production] lookup failed", { stage, kind: "UNEXPECTED" });
        return { status: "ERROR", code: "UNAVAILABLE" };
    }
}
