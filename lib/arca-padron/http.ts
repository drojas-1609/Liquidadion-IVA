import { parseXml, soapFault, XML_MAX_BYTES, XmlParseError } from './xml';
export class LookupFailure extends Error {
    constructor(readonly code: 'TIMEOUT' | 'UNAVAILABLE' | 'AUTH' | 'INVALID_RESPONSE', readonly diagnostic?: { httpStatus?: number; networkCode?: string }) { super(code); }
}
async function boundedText(res: Response, signal: AbortSignal): Promise<string> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > XML_MAX_BYTES) {
        await res.body?.cancel();
        throw new LookupFailure('INVALID_RESPONSE');
    }
    if (!res.body)
        return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (true) {
            if (signal.aborted)
                throw new LookupFailure('TIMEOUT');
            let onAbort: () => void = () => { };
            const abort = new Promise<never>((_, reject) => { onAbort = () => reject(new LookupFailure('TIMEOUT')); signal.addEventListener('abort', onAbort, { once: true }); });
            let part: ReadableStreamReadResult<Uint8Array>;
            try {
                part = await Promise.race([reader.read(), abort]);
            }
            finally {
                signal.removeEventListener('abort', onAbort);
            }
            if (part.done)
                break;
            bytes += part.value.byteLength;
            if (bytes > XML_MAX_BYTES)
                throw new LookupFailure('INVALID_RESPONSE');
            chunks.push(part.value);
        }
        const all = new Uint8Array(bytes);
        let pos = 0;
        for (const c of chunks) {
            all.set(c, pos);
            pos += c.byteLength;
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(all);
    }
    catch (err) {
        await reader.cancel().catch(() => { });
        if (err instanceof LookupFailure)
            throw err;
        throw new LookupFailure('INVALID_RESPONSE');
    }
    finally {
        reader.releaseLock();
    }
}
export async function postSoap(deps: {
    fetchImpl: typeof fetch;
    timeoutMs: number;
}, url: string, body: string, action: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
    try {
        const res = await deps.fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: action }, body, signal: controller.signal, cache: 'no-store', redirect: 'error' });
        const text = await boundedText(res, controller.signal);
        if (!res.ok) {
            try {
                if (!soapFault(parseXml(text)))
                    throw new LookupFailure('UNAVAILABLE', { httpStatus: res.status });
            }
            catch (e) {
                if (e instanceof XmlParseError)
                    throw new LookupFailure('UNAVAILABLE', { httpStatus: res.status });
                throw e;
            }
        }
        return text;
    }
    catch (e) {
        if (e instanceof LookupFailure)
            throw e;
        if (controller.signal.aborted || (e instanceof Error && e.name === 'AbortError'))
            throw new LookupFailure('TIMEOUT');
        const cause = e instanceof Error ? e.cause : undefined;
        const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
        const networkCode = typeof code === 'string' && /^(?:E[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+|CERT_[A-Z0-9_]+|UNABLE_TO_[A-Z0-9_]+|SELF_SIGNED_CERT_IN_CHAIN)$/.test(code) && code.length <= 64
            ? code : undefined;
        throw new LookupFailure('UNAVAILABLE', { networkCode });
    }
    finally {
        clearTimeout(timer);
    }
}
