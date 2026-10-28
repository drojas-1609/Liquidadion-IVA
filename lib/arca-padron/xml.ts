/** Parser restrictivo de respuestas ARCA: tamaño en bytes, profundidad y namespaces. */
export interface XmlElement {
    name: string;
    qname: string;
    namespaceUri: string;
    children: XmlElement[];
    text: string;
}
export class XmlParseError extends Error {
    constructor(message: string) { super(message); this.name = 'XmlParseError'; }
}
export const XML_MAX_BYTES = 512 * 1024;
export const XML_MAX_DEPTH = 64;
export const SOAP_NAMESPACE = 'http://schemas.xmlsoap.org/soap/envelope/';
const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;
function decode(raw: string): string {
    if (/&(?!(?:#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);)/.test(raw))
        throw new XmlParseError('entidad inválida');
    return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, ent: string) => {
        const fixed: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
        if (ent in fixed)
            return fixed[ent];
        const n = ent.startsWith('#x') ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        if (!(n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0xd7ff) || (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff)))
            throw new XmlParseError('referencia inválida');
        return String.fromCodePoint(n);
    });
}
export function parseXml(input: string): XmlElement {
    if (new TextEncoder().encode(input).byteLength > XML_MAX_BYTES)
        throw new XmlParseError('XML demasiado grande');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(input))
        throw new XmlParseError('carácter XML inválido');
    const stack: Array<{
        el: XmlElement;
        ns: Record<string, string>;
    }> = [];
    let root: XmlElement | null = null;
    let i = 0;
    const append = (raw: string) => { if (!raw.trim())
        return; if (!stack.length)
        throw new XmlParseError('texto fuera de raíz'); stack[stack.length - 1].el.text += decode(raw); };
    while (i < input.length) {
        const lt = input.indexOf('<', i);
        if (lt < 0) {
            append(input.slice(i));
            break;
        }
        if (lt > i)
            append(input.slice(i, lt));
        if (input.startsWith('<?', lt)) {
            const end = input.indexOf('?>', lt + 2);
            if (end < 0)
                throw new XmlParseError('instrucción sin cerrar');
            i = end + 2;
            continue;
        }
        if (input.startsWith('<!--', lt)) {
            const end = input.indexOf('-->', lt + 4);
            if (end < 0 || input.slice(lt + 4, end).includes('--'))
                throw new XmlParseError('comentario inválido');
            i = end + 3;
            continue;
        }
        if (input.startsWith('<![CDATA[', lt)) {
            const end = input.indexOf(']]>', lt + 9);
            if (end < 0 || !stack.length)
                throw new XmlParseError('CDATA inválido');
            stack[stack.length - 1].el.text += input.slice(lt + 9, end);
            i = end + 3;
            continue;
        }
        if (input.startsWith('<!', lt))
            throw new XmlParseError('DTD no admitido');
        if (input.startsWith('</', lt)) {
            const end = input.indexOf('>', lt);
            if (end < 0)
                throw new XmlParseError('cierre incompleto');
            const qname = input.slice(lt + 2, end).trim();
            const frame = stack.pop();
            if (!NAME.test(qname) || !frame || frame.el.qname !== qname)
                throw new XmlParseError('etiquetas no balanceadas');
            if (!stack.length)
                root = frame.el;
            i = end + 1;
            continue;
        }
        let end = lt + 1, quote = '';
        for (; end < input.length; end++) {
            const c = input[end];
            if (quote) {
                if (c === quote)
                    quote = '';
            }
            else if (c === '"' || c === "'")
                quote = c;
            else if (c === '>')
                break;
        }
        if (end >= input.length)
            throw new XmlParseError('apertura incompleta');
        let raw = input.slice(lt + 1, end);
        const selfClosing = raw.endsWith('/');
        if (selfClosing)
            raw = raw.slice(0, -1);
        const qname = raw.match(/^([^\s]+)/)?.[1] ?? '';
        if (!NAME.test(qname))
            throw new XmlParseError('nombre inválido');
        const ns: Record<string, string> = { ...(stack.at(-1)?.ns ?? {}), xml: 'http://www.w3.org/XML/1998/namespace' };
        let attrs = raw.slice(qname.length);
        const seen = new Set<string>();
        const names: string[] = [];
        while (attrs.trim()) {
            const a = attrs.match(/^\s+([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)\s*=\s*("[^"]*"|'[^']*')/);
            if (!a || seen.has(a[1]))
                throw new XmlParseError('atributos inválidos');
            seen.add(a[1]);
            names.push(a[1]);
            const value = decode(a[2].slice(1, -1));
            if (value.includes('<'))
                throw new XmlParseError('atributo inválido');
            if (a[1] === 'xmlns')
                ns[''] = value;
            else if (a[1].startsWith('xmlns:')) {
                const prefix = a[1].slice(6);
                if (!value || prefix === 'xmlns' || (prefix === 'xml' && value !== ns.xml))
                    throw new XmlParseError('namespace inválido');
                ns[prefix] = value;
            }
            attrs = attrs.slice(a[0].length);
        }
        for (const name of [qname, ...names.filter(n => n !== 'xmlns' && !n.startsWith('xmlns:'))]) {
            if (name.includes(':') && !ns[name.split(':')[0]])
                throw new XmlParseError('prefijo no declarado');
        }
        const parts = qname.split(':');
        const el: XmlElement = { name: parts.at(-1)!, qname, namespaceUri: ns[parts.length === 2 ? parts[0] : ''] ?? '', children: [], text: '' };
        if (!stack.length && root)
            throw new XmlParseError('más de una raíz');
        if (stack.length >= XML_MAX_DEPTH)
            throw new XmlParseError('profundidad XML excesiva');
        if (stack.length)
            stack[stack.length - 1].el.children.push(el);
        if (selfClosing) {
            if (!stack.length)
                root = el;
        }
        else
            stack.push({ el, ns });
        i = end + 1;
    }
    if (stack.length || !root)
        throw new XmlParseError('documento incompleto');
    return root;
}
export function child(el: XmlElement | undefined, name: string): XmlElement | undefined { return el?.children.find(c => c.name === name); }
export function childrenNamed(el: XmlElement | undefined, name: string): XmlElement[] { return el?.children.filter(c => c.name === name) ?? []; }
export function find(el: XmlElement | undefined, name: string): XmlElement | undefined { if (!el)
    return undefined; for (const c of el.children) {
    if (c.name === name)
        return c;
    const hit = find(c, name);
    if (hit)
        return hit;
} return undefined; }
export function childText(el: XmlElement | undefined, name: string): string | null { return child(el, name)?.text.trim() || null; }
export function escapeXml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
export function soapBody(doc: XmlElement): XmlElement | undefined { if (doc.name !== 'Envelope' || doc.namespaceUri !== SOAP_NAMESPACE)
    return undefined; const bodies = doc.children.filter(c => c.name === 'Body' && c.namespaceUri === SOAP_NAMESPACE); return bodies.length === 1 ? bodies[0] : undefined; }
export function soapFault(doc: XmlElement): XmlElement | undefined { return soapBody(doc)?.children.find(c => c.name === 'Fault' && c.namespaceUri === SOAP_NAMESPACE); }
