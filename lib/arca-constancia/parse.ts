/**
 * Lectura de la «Constancia de inscripción» de ARCA (PDF de la consulta
 * pública, con el bloque de Comisión Arbitral). Recibe el texto ya extraído
 * del PDF (lib/arca-constancia/pdf-text) y devuelve los datos ordenados.
 *
 * Lógica pura y defensiva: lo que no se reconoce queda en null o vacío (nunca
 * se completa con suposiciones); el régimen de IIBB sólo se propone cuando la
 * constancia lo nombra («CONVENIO MULTILATERAL» o «LOCAL»).
 */

export interface ConstanciaTax { name: string; since: string | null }
export interface ConstanciaActivity { code: string; description: string; since: string | null; principal: boolean; article: string | null }
export interface ConstanciaJurisdiction { code: string; name: string; since: string | null }

export interface Constancia {
    cuit: string;
    name: string;
    /** Vigencia de la constancia: desde (fecha de emisión) y hasta, YYYY-MM-DD. */
    issuedOn: string | null;
    validUntil: string | null;
    verifier: string | null;
    fiscalAddress: string | null;
    jurisdictionalAddress: string | null;
    closingMonth: number | null;
    nationalTaxes: ConstanciaTax[];
    nationalActivities: ConstanciaActivity[];
    iibb: {
        /** Texto tal cual figura, p. ej. «IIBB CONVENIO MULTILATERAL - ACTIVO». */
        raw: string;
        regime: "CONVENIO_MULTILATERAL" | "LOCAL" | null;
        active: boolean;
        since: string | null;
    } | null;
    jurisdictions: ConstanciaJurisdiction[];
    /** Jurisdicción sede (CM): la de las adheridas que figura en el domicilio jurisdiccional. */
    headquartersCode: string | null;
    provincialActivities: ConstanciaActivity[];
}

export class ConstanciaParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConstanciaParseError";
    }
}

const H = {
    national: "IMPUESTOS/REGIMENES NACIONALES REGISTRADOS Y FECHA DE ALTA",
    natActs: "ACTIVIDADES NACIONALES REGISTRADAS Y FECHA DE ALTA",
    fiscalAddr: "DOMICILIO FISCAL - ARCA",
    provTaxes: "IMPUESTOS PROVINCIALES - FECHA DE ALTA",
    jurisdictions: "JURISDICCIONES ADHERIDAS - FECHA DE ALTA",
    provActs: "ACTIVIDADES PROVINCIALES REGISTRADAS Y FECHA DE ALTA",
    jurAddr: "DOMICILIO FISCAL - JURISDICCIONAL / SEDE",
} as const;

function norm(s: string): string {
    return s
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toUpperCase()
        .replace(/\b(DE|DEL)\b/g, " ")
        .replace(/[^A-Z0-9]+/g, " ")
        .trim();
}

/** «08-2026» u «08/2026» → «2026-08»; «31-07-2026» → «2026-07-31». */
function monthOf(s: string | undefined): string | null {
    const m = /(\d{2})[-/](\d{4})/.exec(s ?? "");
    return m ? `${m[2]}-${m[1]}` : null;
}
function dayOf(s: string | undefined): string | null {
    const m = /(\d{2})-(\d{2})-(\d{4})/.exec(s ?? "");
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Líneas entre un encabezado y el siguiente encabezado conocido. */
function section(lines: string[], head: string): string[] {
    const i = lines.findIndex((l) => l === head);
    if (i < 0) return [];
    const heads = new Set<string>(Object.values(H));
    const out: string[] = [];
    for (let k = i + 1; k < lines.length; k++) {
        if (heads.has(lines[k]) || /^Vigencia de la presente constancia/.test(lines[k]) || /^Esta constancia no da cuenta/.test(lines[k])) break;
        out.push(lines[k]);
    }
    return out;
}

/** Actividades: «Actividad principal: CODIGO …», «Secundaria(s): CODIGO …» y continuaciones. */
function parseActivities(block: string[], provincial: boolean): ConstanciaActivity[] {
    const out: ConstanciaActivity[] = [];
    let current: ConstanciaActivity | null = null;
    for (const raw of block) {
        if (/^Mes de cierre ejercicio comercial/.test(raw)) break;
        const line = raw.replace(/^Actividad principal:\s*/, "\u0001").replace(/^Secundaria\(s\):\s*/, "\u0002");
        const principal = line.startsWith("\u0001");
        const body = line.replace(/^[\u0001\u0002]/, "");
        const start = /^(\d{6})\s+(.*)$/.exec(body);
        if (start) {
            current = { code: start[1], description: "", since: null, principal, article: null };
            out.push(current);
            appendTail(current, start[2], provincial);
        } else if (current) {
            appendTail(current, body, provincial);
        }
    }
    for (const a of out) a.description = a.description.replace(/\s+/g, " ").trim();
    return out;
}

function appendTail(a: ConstanciaActivity, text: string, provincial: boolean) {
    let t = text;
    const since = provincial ? /\s*desde:\s*(\d{2}\/\d{4})\s*$/.exec(t) : /\s*Mes de inicio:\s*(\d{2}\/\d{4})\s*$/.exec(t);
    if (since) {
        a.since = monthOf(since[1]);
        t = t.slice(0, since.index);
    }
    const art = /\s*Art:\s*(\d+)\s*$/.exec(t);
    if (art) {
        a.article = art[1];
        t = t.slice(0, art.index);
    }
    t = t.replace(provincial ? /^NAES\s+/ : /^\(F-\d+\)\s+/, "");
    a.description += ` ${t}`;
}

export function parseConstancia(text: string): Constancia {
    const lines = text
        .split(/\r?\n/)
        .map((l) => l.replace(/\s+/g, " ").trim())
        .filter(Boolean);
    if (!lines.some((l) => l === "CONSTANCIA DE INSCRIPCION")) throw new ConstanciaParseError("El archivo no parece una constancia de inscripción de ARCA.");

    // Encabezado: «RAZÓN SOCIAL CUIT: 30-12345678-9», luego los domicilios (fiscal y jurisdiccional, dos líneas cada uno).
    const headIdx = lines.findIndex((l) => /CUIT:\s*\d{2}-\d{8}-\d/.test(l));
    if (headIdx < 0) throw new ConstanciaParseError("No se encontró el CUIT en la constancia.");
    const hm = /^(.*?)\s*CUIT:\s*(\d{2}-\d{8}-\d)/.exec(lines[headIdx])!;
    const before = lines.slice(headIdx + 1, lines.indexOf("CONSTANCIA DE INSCRIPCION"));
    const addr = (a?: string, b?: string) => (a ? [a, b].filter(Boolean).join(", ") : null);
    const fiscalAddress = addr(before[0], before[1]);
    const jurisdictionalAddress = addr(before[2], before[3]) ?? null;

    const nationalTaxes: ConstanciaTax[] = section(lines, H.national)
        .map((l) => /^(.*?)\s+(\d{2}-\d{4})$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => ({ name: m[1], since: monthOf(m[2]) }));

    const natBlock = section(lines, H.natActs);
    const closing = natBlock.map((l) => /^Mes de cierre ejercicio comercial:\s*(\d{1,2})/.exec(l)).find(Boolean);

    const provTax = section(lines, H.provTaxes).find((l) => /^IIBB\b/.test(l));
    let iibb: Constancia["iibb"] = null;
    if (provTax) {
        const m = /^(.*?)\s+(\d{2}\/\d{4})$/.exec(provTax);
        const rawName = (m ? m[1] : provTax).trim();
        const n = norm(rawName);
        iibb = {
            raw: rawName,
            regime: n.includes("CONVENIO MULTILATERAL") ? "CONVENIO_MULTILATERAL" : /\bLOCAL\b/.test(n) ? "LOCAL" : null,
            active: /\bACTIVO\b/.test(n),
            since: monthOf(m?.[2]),
        };
    }

    const jurisdictions: ConstanciaJurisdiction[] = section(lines, H.jurisdictions)
        .map((l) => /^(9\d{2})\s+(.*?)(?:\s+desde:\s*(\d{2}\/\d{4}))?$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => ({ code: m[1], name: m[2].trim(), since: monthOf(m[3]) }));

    // Sede: la jurisdicción adherida cuyo nombre aparece en el domicilio jurisdiccional (el nombre más largo gana:
    // «CIUDAD AUTONOMA BUENOS AIRES» antes que «BUENOS AIRES»).
    let headquartersCode: string | null = null;
    if (jurisdictionalAddress) {
        const where = norm(jurisdictionalAddress);
        const hit = jurisdictions
            .filter((j) => new RegExp(`(^| )${norm(j.name)}( |$)`).test(where))
            .sort((a, b) => norm(b.name).length - norm(a.name).length)[0];
        headquartersCode = hit?.code ?? null;
    }

    const vig = lines.find((l) => /^Vigencia de la presente constancia/.test(l)) ?? "";
    const vm = /constancia:\s*(\d{2}-\d{2}-\d{4})\s*a\s*(\d{2}-\d{2}-\d{4})/.exec(vig);
    const ver = /Verificador\s+(\d+)/.exec(vig);

    return {
        cuit: hm[2],
        name: hm[1].trim(),
        issuedOn: dayOf(vm?.[1]),
        validUntil: dayOf(vm?.[2]),
        verifier: ver?.[1] ?? null,
        fiscalAddress,
        jurisdictionalAddress,
        closingMonth: closing ? Number(closing[1]) : null,
        nationalTaxes,
        nationalActivities: parseActivities(natBlock, false),
        iibb,
        jurisdictions,
        headquartersCode,
        provincialActivities: parseActivities(section(lines, H.provActs), true),
    };
}
