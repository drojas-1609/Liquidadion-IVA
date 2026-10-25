import { describe, it, expect, vi } from "vitest";
import { cuitCheckDigit } from "@/lib/cuit";
import { parseXml, XmlParseError, escapeXml } from "@/lib/arca-padron/xml";
import { buildGetPersonaV2Request, parseGetPersonaV2Response, PADRON_ENDPOINTS, PADRON_SERVICE } from "@/lib/arca-padron/padron";
import { buildLoginCmsRequest, buildLoginTicketRequest, parseLoginCmsResponse, ticketUsable, WSAA_ENDPOINTS } from "@/lib/arca-padron/wsaa";
import { readArcaConfig, resolveCmsSigner } from "@/lib/arca-padron/config";
import { lookupCuit, type LookupDeps } from "@/lib/arca-padron/service";
import { SlidingWindowLimiter } from "@/lib/arca-padron/rate-limit";

// Datos SINTÉTICOS: CUIT ficticio con dígito verificador válido.
function syntheticCuit(mid: string, prefix = "30"): string {
    const dv = cuitCheckDigit(prefix + mid);
    if (dv === null) throw new Error("sin DV");
    return `${prefix}${mid}${dv}`;
}
const CUIT = syntheticCuit("70000001");
const CUIT_FMT = `${CUIT.slice(0, 2)}-${CUIT.slice(2, 10)}-${CUIT[10]}`;
const OTHER = syntheticCuit("70000002", "20");
const REPRESENTADA = syntheticCuit("70000003", "20");
const SECRET_TOKEN = "TOKEN-SINTETICO-SECRETO";
const SECRET_SIGN = "SIGN-SINTETICO-SECRETO";

const envelope = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`;
const personaResponse = (inner: string) =>
    envelope(`<ns2:getPersona_v2Response xmlns:ns2="http://a5.soap.ws.server.puc.sr/"><personaReturn>${inner}</personaReturn></ns2:getPersona_v2Response>`);
const FOUND = personaResponse(
    `<datosGenerales><domicilioFiscal><codPostal>1000</codPostal><descripcionProvincia>CIUDAD AUTONOMA BUENOS AIRES</descripcionProvincia>` +
        `<direccion>CALLE SINTETICA 123</direccion><idProvincia>0</idProvincia><localidad>LOCALIDAD DE PRUEBA</localidad></domicilioFiscal>` +
        `<estadoClave>ACTIVO</estadoClave><idPersona>${CUIT}</idPersona><razonSocial>EMPRESA SINTETICA &amp; ASOCIADOS SA</razonSocial>` +
        `<tipoPersona>JURIDICA</tipoPersona></datosGenerales>` +
        `<datosRegimenGeneral><actividad><descripcionActividad>SERVICIOS SINTETICOS</descripcionActividad><idActividad>620100</idActividad>` +
        `<nomenclador>883</nomenclador><orden>1</orden><periodo>201801</periodo></actividad>` +
        `<impuesto><descripcionImpuesto>IVA</descripcionImpuesto><estadoImpuesto>AC</estadoImpuesto><idImpuesto>30</idImpuesto><periodo>201801</periodo></impuesto>` +
        `</datosRegimenGeneral><metadata><fechaHora>2026-10-25T10:00:00-03:00</fechaHora><servidor>sintetico</servidor></metadata>`,
);

describe("xml — parser restrictivo", () => {
    it("entidades, CDATA, prefijos y autocierre", () => {
        const doc = parseXml(`<?xml version="1.0"?><a:r xmlns:a="x"><b>1 &lt; 2 &amp; &#65;&#x42;</b><c><![CDATA[<crudo>]]></c><d/></a:r>`);
        expect(doc.name).toBe("r");
        expect(doc.children.map((c) => [c.name, c.text])).toEqual([
            ["b", "1 < 2 & AB"],
            ["c", "<crudo>"],
            ["d", ""],
        ]);
    });
    it.each([
        ["DOCTYPE", `<!DOCTYPE x [<!ENTITY e "boom">]><r>&e;</r>`],
        ["mal balanceado", "<a><b></a></b>"],
        ["sin cerrar", "<a><b></b>"],
        ["& suelto", "<a>x & y</a>"],
        ["entidad desconocida", "<a>&e;</a>"],
        ["dos raíces", "<a/><b/>"],
        ["vacío", "   "],
    ])("rechaza %s", (_l, xml) => {
        expect(() => parseXml(xml)).toThrow(XmlParseError);
    });
    it("límite de tamaño", () => {
        expect(() => parseXml(`<a>${"x".repeat(600 * 1024)}</a>`)).toThrow(XmlParseError);
    });
    it("escapeXml", () => {
        expect(escapeXml(`<a&"'>`)).toBe("&lt;a&amp;&quot;&apos;&gt;");
    });
});

describe("padrón ws_sr_constancia_inscripcion — getPersona_v2", () => {
    it("endpoints oficiales y servicio", () => {
        expect(PADRON_SERVICE).toBe("ws_sr_constancia_inscripcion");
        expect(PADRON_ENDPOINTS).toEqual({
            homologacion: "https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5",
            produccion: "https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5",
        });
    });
    it("request: escapa token/sign y exige CUITs de 11 dígitos", () => {
        const xml = buildGetPersonaV2Request({ token: "a<b", sign: "c&d", cuitRepresentada: REPRESENTADA, idPersona: CUIT });
        expect(xml).toContain("<token>a&lt;b</token>");
        expect(xml).toContain("<sign>c&amp;d</sign>");
        expect(xml).toContain(`<idPersona>${CUIT}</idPersona>`);
        expect(() => buildGetPersonaV2Request({ token: "t", sign: "s", cuitRepresentada: REPRESENTADA, idPersona: "30-1" })).toThrow();
    });
    it("FOUND: extrae sólo los datos de la ficha", () => {
        const r = parseGetPersonaV2Response(FOUND, CUIT);
        expect(r).toEqual({
            kind: "FOUND",
            person: {
                idPersona: CUIT,
                name: "EMPRESA SINTETICA & ASOCIADOS SA",
                personType: "JURIDICA",
                keyStatus: "ACTIVO",
                fiscalAddress: {
                    street: "CALLE SINTETICA 123",
                    locality: "LOCALIDAD DE PRUEBA",
                    postalCode: "1000",
                    provinceArcaId: "0",
                    provinceName: "CIUDAD AUTONOMA BUENOS AIRES",
                },
                taxes: [{ id: "30", description: "IVA", status: "AC" }],
                monotributoCategory: null,
                activities: [{ code: "620100", description: "SERVICIOS SINTETICOS", nomenclator: "883", order: 1, period: "201801" }],
                notices: [],
                sourceDateTime: "2026-10-25T10:00:00-03:00",
            },
        });
    });
    it("persona física: apellido y nombre", () => {
        const xml = personaResponse(`<datosGenerales><apellido>PEREZ</apellido><nombre>ANA</nombre><idPersona>${CUIT}</idPersona></datosGenerales>`);
        const r = parseGetPersonaV2Response(xml, CUIT);
        expect(r.kind === "FOUND" && r.person.name).toBe("PEREZ ANA");
    });
    it("NOT_FOUND: fault 'No existe persona', personaReturn ausente o errorConstancia", () => {
        const fault = envelope(`<soap:Fault><faultcode>soap:Server</faultcode><faultstring>No existe persona con ese Id</faultstring></soap:Fault>`);
        expect(parseGetPersonaV2Response(fault, CUIT)).toEqual({ kind: "NOT_FOUND" });
        expect(parseGetPersonaV2Response(envelope(`<ns2:getPersona_v2Response xmlns:ns2="x"/>`), CUIT)).toEqual({ kind: "NOT_FOUND" });
        const err = personaResponse(`<errorConstancia><error>No existe persona con ese Id</error></errorConstancia>`);
        expect(parseGetPersonaV2Response(err, CUIT)).toEqual({ kind: "NOT_FOUND" });
    });
    it("otro fault -> FAULT (sin exponer su texto)", () => {
        const fault = envelope(`<soap:Fault><faultstring>Error interno ${SECRET_TOKEN}</faultstring></soap:Fault>`);
        expect(parseGetPersonaV2Response(fault, CUIT)).toEqual({ kind: "FAULT" });
    });
    it("respuesta de OTRO CUIT -> INVALID (nunca se proponen datos ajenos)", () => {
        expect(parseGetPersonaV2Response(FOUND, OTHER)).toEqual({ kind: "INVALID" });
    });
    it.each(["no es xml", "<html><body>error</body></html>", envelope("<otra/>"), envelope(`<ns2:getPersona_v2Response xmlns:ns2="x"><personaReturn><metadata/></personaReturn></ns2:getPersona_v2Response>`)])(
        "respuesta inválida -> INVALID: %s",
        (xml) => {
            expect(parseGetPersonaV2Response(xml, CUIT)).toEqual({ kind: "INVALID" });
        },
    );
    it("errorConstancia con datos: se informan como avisos (máximo 5)", () => {
        const errors = Array.from({ length: 7 }, (_, i) => `<error>Aviso ${i}</error>`).join("");
        const xml = personaResponse(`<datosGenerales><idPersona>${CUIT}</idPersona><razonSocial>X</razonSocial></datosGenerales><errorConstancia>${errors}</errorConstancia>`);
        const r = parseGetPersonaV2Response(xml, CUIT);
        expect(r.kind === "FOUND" && r.person.notices).toHaveLength(5);
    });
});

describe("WSAA — loginCms", () => {
    it("endpoints oficiales", () => {
        expect(WSAA_ENDPOINTS).toEqual({
            homologacion: "https://wsaahomo.afip.gov.ar/ws/services/LoginCms",
            produccion: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
        });
    });
    it("TRA con servicio, uniqueId y ventana de validez", () => {
        const tra = buildLoginTicketRequest({ service: PADRON_SERVICE, nowMs: Date.parse("2026-10-25T12:00:00Z"), uniqueId: 1792929600 });
        expect(tra).toContain("<uniqueId>1792929600</uniqueId>");
        expect(tra).toContain("<generationTime>2026-10-25T11:59:00Z</generationTime>");
        expect(tra).toContain("<expirationTime>2026-10-25T12:10:00Z</expirationTime>");
        expect(tra).toContain(`<service>${PADRON_SERVICE}</service>`);
    });
    it("loginCms: el CMS va en in0 y se rechaza contenido no base64", () => {
        expect(buildLoginCmsRequest("QUJD\nRA==")).toContain("<wsaa:in0>QUJDRA==</wsaa:in0>");
        expect(() => buildLoginCmsRequest("<x/>")).toThrow();
    });
    const inner = (exp: string) =>
        escapeXml(
            `<?xml version="1.0"?><loginTicketResponse version="1"><header><expirationTime>${exp}</expirationTime></header>` +
                `<credentials><token>${SECRET_TOKEN}</token><sign>${SECRET_SIGN}</sign></credentials></loginTicketResponse>`,
        );
    it("respuesta: token, sign y vencimiento", () => {
        const xml = envelope(`<loginCmsResponse><loginCmsReturn>${inner("2026-10-25T23:00:00-03:00")}</loginCmsReturn></loginCmsResponse>`);
        expect(parseLoginCmsResponse(xml)).toEqual({
            kind: "TICKET",
            ticket: { token: SECRET_TOKEN, sign: SECRET_SIGN, expiresAt: Date.parse("2026-10-25T23:00:00-03:00") },
        });
    });
    it("fault o respuesta incompleta", () => {
        expect(parseLoginCmsResponse(envelope("<soap:Fault><faultstring>cms.bad</faultstring></soap:Fault>"))).toEqual({ kind: "FAULT" });
        expect(parseLoginCmsResponse(envelope("<loginCmsResponse><loginCmsReturn></loginCmsReturn></loginCmsResponse>"))).toEqual({ kind: "INVALID" });
        expect(parseLoginCmsResponse("basura")).toEqual({ kind: "INVALID" });
    });
    it("ticket reutilizable sólo con más de 5 minutos de margen", () => {
        expect(ticketUsable({ token: "t", sign: "s", expiresAt: 1_000_000 }, 1_000_000 - 6 * 60_000)).toBe(true);
        expect(ticketUsable({ token: "t", sign: "s", expiresAt: 1_000_000 }, 1_000_000 - 4 * 60_000)).toBe(false);
        expect(ticketUsable(null, 0)).toBe(false);
    });
});

describe("configuración", () => {
    const full = {
        ARCA_PADRON_ENABLED: "true",
        ARCA_PADRON_ENV: "homologacion",
        ARCA_PADRON_CUIT_REPRESENTADA: REPRESENTADA,
        ARCA_WSAA_CERT_PEM: "-----BEGIN CERTIFICATE-----\nSINTETICO\n-----END CERTIFICATE-----",
        ARCA_WSAA_KEY_PEM: "-----BEGIN PRIVATE KEY-----\nSINTETICO\n-----END PRIVATE KEY-----",
    };
    const signer = async () => "QUJD";
    it("deshabilitada por defecto", () => {
        expect(readArcaConfig({})).toEqual({ configured: false, reason: "DISABLED", missing: [] });
    });
    it("faltan variables: informa NOMBRES, nunca valores", () => {
        const r = readArcaConfig({ ARCA_PADRON_ENABLED: "true", ARCA_PADRON_ENV: "homologacion" });
        expect(r).toEqual({ configured: false, reason: "MISSING_SETTINGS", missing: ["ARCA_PADRON_CUIT_REPRESENTADA", "ARCA_WSAA_CERT_PEM", "ARCA_WSAA_KEY_PEM"] });
    });
    it("valores inválidos", () => {
        const r = readArcaConfig({ ...full, ARCA_PADRON_ENV: "otro", ARCA_WSAA_KEY_PEM: "no-pem" }, () => signer);
        expect(r).toMatchObject({ configured: false, reason: "INVALID_SETTINGS", missing: ["ARCA_PADRON_ENV", "ARCA_WSAA_KEY_PEM"] });
        expect(JSON.stringify(r)).not.toContain("no-pem");
    });
    it("sin firmante CMS disponible: NO configurada aunque estén las variables", () => {
        expect(resolveCmsSigner("x", "y")).toBeNull();
        expect(readArcaConfig(full)).toEqual({ configured: false, reason: "SIGNER_UNAVAILABLE", missing: [] });
    });
    it("con firmante: configurada", () => {
        expect(readArcaConfig(full, () => signer)).toMatchObject({ configured: true, environment: "homologacion", cuitRepresentada: REPRESENTADA });
    });
});

describe("servicio lookupCuit (red simulada)", () => {
    const ticketXml = envelope(
        `<loginCmsResponse><loginCmsReturn>${escapeXml(
            `<loginTicketResponse><header><expirationTime>2099-01-01T00:00:00Z</expirationTime></header><credentials><token>${SECRET_TOKEN}</token><sign>${SECRET_SIGN}</sign></credentials></loginTicketResponse>`,
        )}</loginCmsReturn></loginCmsResponse>`,
    );
    function deps(handler: (url: string, init: RequestInit) => Promise<Response>, over: Partial<LookupDeps> = {}): LookupDeps {
        let ticket: ReturnType<LookupDeps["ticketCache"]["get"]> = null;
        return {
            fetchImpl: vi.fn(handler) as unknown as typeof fetch,
            config: { configured: true, environment: "homologacion", cuitRepresentada: REPRESENTADA, signer: async () => "QUJD" },
            nowMs: () => Date.parse("2026-10-25T12:00:00Z"),
            timeoutMs: 50,
            ticketCache: { get: () => ticket, set: (t) => void (ticket = t) },
            ...over,
        };
    }
    const ok = (body: string, status = 200) => Promise.resolve(new Response(body, { status }));

    it("CUIT inválido: no consulta", async () => {
        const d = deps(() => ok(""));
        expect(await lookupCuit("30-1", d)).toMatchObject({ status: "INVALID_CUIT" });
        expect(d.fetchImpl).not.toHaveBeenCalled();
    });
    it("no configurada: no consulta y no simula datos", async () => {
        const d = deps(() => ok(""), { config: { configured: false, reason: "SIGNER_UNAVAILABLE", missing: [] } });
        expect(await lookupCuit(CUIT_FMT, d)).toEqual({ status: "NOT_CONFIGURED" });
        expect(d.fetchImpl).not.toHaveBeenCalled();
    });
    it("FOUND: CUIT normalizado, ticket WSAA y luego padrón; resultado sin secretos", async () => {
        const d = deps((url) => ok(url.includes("LoginCms") ? ticketXml : FOUND));
        const r = await lookupCuit(`${CUIT.slice(0, 2)} ${CUIT.slice(2, 10)} ${CUIT[10]}`, d);
        expect(r).toMatchObject({ status: "FOUND", cuit: CUIT_FMT, consultedAt: "2026-10-25T12:00:00.000Z" });
        const calls = (d.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls.map((c) => c[0])).toEqual([WSAA_ENDPOINTS.homologacion, PADRON_ENDPOINTS.homologacion]);
        expect(String(calls[1][1].body)).toContain(`<idPersona>${CUIT}</idPersona>`);
        expect(JSON.stringify(r)).not.toMatch(/SECRETO|BEGIN/);
    });
    it("reutiliza el ticket vigente (una sola autenticación)", async () => {
        const d = deps((url) => ok(url.includes("LoginCms") ? ticketXml : FOUND));
        await lookupCuit(CUIT, d);
        await lookupCuit(CUIT, d);
        const urls = (d.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
        expect(urls.filter((u: string) => u.includes("LoginCms"))).toHaveLength(1);
    });
    it("NOT_FOUND", async () => {
        const nf = envelope(`<soap:Fault><faultstring>No existe persona con ese Id</faultstring></soap:Fault>`);
        expect(await lookupCuit(CUIT, deps((url) => (url.includes("LoginCms") ? ok(ticketXml) : ok(nf, 500))))).toEqual({ status: "NOT_FOUND", cuit: CUIT_FMT });
    });
    it("timeout -> ERROR TIMEOUT", async () => {
        const d = deps((_url, init) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))));
        expect(await lookupCuit(CUIT, d)).toEqual({ status: "ERROR", code: "TIMEOUT" });
    });
    it("5xx sin SOAP o red caída -> UNAVAILABLE", async () => {
        expect(await lookupCuit(CUIT, deps(() => ok("Service Unavailable", 503)))).toEqual({ status: "ERROR", code: "UNAVAILABLE" });
        expect(await lookupCuit(CUIT, deps(() => Promise.reject(new TypeError("fetch failed"))))).toEqual({ status: "ERROR", code: "UNAVAILABLE" });
    });
    it("WSAA rechaza el certificado o falla la firma -> AUTH", async () => {
        const fault = envelope("<soap:Fault><faultstring>ns1:cms.cert.untrusted</faultstring></soap:Fault>");
        expect(await lookupCuit(CUIT, deps(() => ok(fault, 500)))).toEqual({ status: "ERROR", code: "AUTH" });
        const badSigner = deps(() => ok(ticketXml), {
            config: { configured: true, environment: "homologacion", cuitRepresentada: REPRESENTADA, signer: async () => { throw new Error("BEGIN PRIVATE KEY"); } },
        });
        expect(await lookupCuit(CUIT, badSigner)).toEqual({ status: "ERROR", code: "AUTH" });
    });
    it("respuesta inválida o de otro CUIT -> INVALID_RESPONSE", async () => {
        expect(await lookupCuit(OTHER, deps((url) => ok(url.includes("LoginCms") ? ticketXml : FOUND)))).toEqual({ status: "ERROR", code: "INVALID_RESPONSE" });
        expect(await lookupCuit(CUIT, deps((url) => ok(url.includes("LoginCms") ? ticketXml : "<html/>")))).toEqual({ status: "ERROR", code: "INVALID_RESPONSE" });
    });
    it("no escribe en consola (sin CUIT, tickets ni respuestas en logs)", async () => {
        const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
        await lookupCuit(CUIT, deps((url) => ok(url.includes("LoginCms") ? ticketXml : FOUND)));
        await lookupCuit(CUIT, deps(() => ok("x", 503)));
        for (const s of spies) {
            expect(s).not.toHaveBeenCalled();
            s.mockRestore();
        }
    });
});

describe("límite de uso", () => {
    it("ventana deslizante por clave; un intento rechazado no cuenta", () => {
        const l = new SlidingWindowLimiter();
        const rule = { limit: 2, windowMs: 1000 };
        expect(l.tryConsume([{ key: "a", rule }], 0)).toBe(true);
        expect(l.tryConsume([{ key: "a", rule }], 10)).toBe(true);
        expect(l.tryConsume([{ key: "a", rule }], 20)).toBe(false);
        expect(l.tryConsume([{ key: "b", rule }], 20)).toBe(true);
        expect(l.tryConsume([{ key: "a", rule }], 1001)).toBe(true);
    });
    it("varias reglas: si una excede, no se consume ninguna", () => {
        const l = new SlidingWindowLimiter();
        const tight = { limit: 1, windowMs: 1000 };
        const loose = { limit: 10, windowMs: 1000 };
        expect(l.tryConsume([{ key: "p", rule: tight }, { key: "o", rule: loose }], 0)).toBe(true);
        expect(l.tryConsume([{ key: "p", rule: tight }, { key: "o", rule: loose }], 1)).toBe(false);
        for (let i = 0; i < 9; i++) expect(l.tryConsume([{ key: `p${i}`, rule: tight }, { key: "o", rule: loose }], 2)).toBe(true);
        expect(l.tryConsume([{ key: "pz", rule: tight }, { key: "o", rule: loose }], 3)).toBe(false);
    });
});
