/**
 * Parser XML mínimo para las respuestas SOAP de ARCA (WSAA y padrón).
 *
 * Sin dependencias. Deliberadamente restrictivo:
 *  - rechaza DOCTYPE/DTD (sin expansión de entidades ni entidades externas);
 *  - sólo las entidades predefinidas y referencias numéricas;
 *  - límite de tamaño;
 *  - los prefijos de namespace se descartan (se usa el nombre local).
 * Una entrada mal formada lanza `XmlParseError`; nunca se "repara".
 */

export interface XmlElement {
    /** Nombre local (sin prefijo de namespace). */
    name: string;
    children: XmlElement[];
    /** Texto directo concatenado (sin el de los hijos), con entidades resueltas. */
    text: string;
}

export class XmlParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "XmlParseError";
    }
}

export const XML_MAX_BYTES = 512 * 1024;

const NAME_RE = /^[A-Za-z_][\w.-]*(:[A-Za-z_][\w.-]*)?$/;

function decodeEntities(s: string): string {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);?/g, (m, ent: string) => {
        if (!m.endsWith(";")) throw new XmlParseError("entidad sin terminar");
        if (ent === "lt") return "<";
        if (ent === "gt") return ">";
        if (ent === "amp") return "&";
        if (ent === "quot") return '"';
        if (ent === "apos") return "'";
        const code = ent.startsWith("#x") ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        if (!Number.isFinite(code) || code > 0x10ffff) throw new XmlParseError("referencia numérica inválida");
        return String.fromCodePoint(code);
    });
}

function localName(qname: string): string {
    const i = qname.indexOf(":");
    return i === -1 ? qname : qname.slice(i + 1);
}

export function parseXml(input: string): XmlElement {
    if (input.length > XML_MAX_BYTES) throw new XmlParseError("respuesta XML demasiado grande");
    let i = 0;
    const n = input.length;
    const stack: XmlElement[] = [];
    let root: XmlElement | null = null;

    const appendText = (raw: string) => {
        if (raw.trim() === "") return;
        if (raw.includes("&") && /&(?!(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);)/.test(raw)) {
            throw new XmlParseError("'&' sin escapar");
        }
        if (stack.length === 0) throw new XmlParseError("texto fuera del elemento raíz");
        stack[stack.length - 1].text += decodeEntities(raw);
    };

    while (i < n) {
        const lt = input.indexOf("<", i);
        if (lt === -1) {
            appendText(input.slice(i));
            break;
        }
        if (lt > i) appendText(input.slice(i, lt));
        if (input.startsWith("<?", lt)) {
            const end = input.indexOf("?>", lt + 2);
            if (end === -1) throw new XmlParseError("instrucción de procesamiento sin cerrar");
            i = end + 2;
        } else if (input.startsWith("<!--", lt)) {
            const end = input.indexOf("-->", lt + 4);
            if (end === -1) throw new XmlParseError("comentario sin cerrar");
            i = end + 3;
        } else if (input.startsWith("<![CDATA[", lt)) {
            const end = input.indexOf("]]>", lt + 9);
            if (end === -1) throw new XmlParseError("CDATA sin cerrar");
            if (stack.length === 0) throw new XmlParseError("CDATA fuera del elemento raíz");
            stack[stack.length - 1].text += input.slice(lt + 9, end);
            i = end + 3;
        } else if (input.startsWith("<!", lt)) {
            throw new XmlParseError("DOCTYPE/DTD no admitido");
        } else if (input.startsWith("</", lt)) {
            const end = input.indexOf(">", lt);
            if (end === -1) throw new XmlParseError("etiqueta de cierre sin terminar");
            const name = input.slice(lt + 2, end).trim();
            const open = stack.pop();
            if (!open || open.name !== localName(name)) throw new XmlParseError("etiquetas no balanceadas");
            if (stack.length === 0) root = open;
            i = end + 1;
        } else {
            // Etiqueta de apertura: nombre + atributos (ignorados) + "/>" opcional.
            let j = lt + 1;
            let quote: string | null = null;
            while (j < n) {
                const c = input[j];
                if (quote) {
                    if (c === quote) quote = null;
                } else if (c === '"' || c === "'") quote = c;
                else if (c === ">") break;
                j++;
            }
            if (j >= n) throw new XmlParseError("etiqueta sin terminar");
            let body = input.slice(lt + 1, j);
            const selfClosing = body.endsWith("/");
            if (selfClosing) body = body.slice(0, -1);
            const qname = body.trim().split(/\s+/, 1)[0] ?? "";
            if (!NAME_RE.test(qname)) throw new XmlParseError("nombre de elemento inválido");
            if (stack.length === 0 && root !== null) throw new XmlParseError("más de un elemento raíz");
            const el: XmlElement = { name: localName(qname), children: [], text: "" };
            if (stack.length > 0) stack[stack.length - 1].children.push(el);
            if (selfClosing) {
                if (stack.length === 0) root = el;
            } else {
                stack.push(el);
            }
            i = j + 1;
        }
    }
    if (stack.length > 0) throw new XmlParseError("elementos sin cerrar");
    if (!root) throw new XmlParseError("documento vacío");
    return root;
}

/** Primer hijo directo con ese nombre local. */
export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
    return el?.children.find((c) => c.name === name);
}

/** Todos los hijos directos con ese nombre local. */
export function childrenNamed(el: XmlElement | undefined, name: string): XmlElement[] {
    return el ? el.children.filter((c) => c.name === name) : [];
}

/** Primer descendiente (búsqueda en profundidad) con ese nombre local. */
export function find(el: XmlElement | undefined, name: string): XmlElement | undefined {
    if (!el) return undefined;
    for (const c of el.children) {
        if (c.name === name) return c;
        const hit = find(c, name);
        if (hit) return hit;
    }
    return undefined;
}

/** Texto (sin espacios en los extremos) del hijo directo, o null si no existe o está vacío. */
export function childText(el: XmlElement | undefined, name: string): string | null {
    const t = child(el, name)?.text.trim();
    return t ? t : null;
}

/** Escapa texto para incluirlo en un documento XML. */
export function escapeXml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
