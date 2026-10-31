import { describe, it, expect } from 'vitest';
import forge from 'node-forge';
import { execFileSync } from 'node:child_process';
import { createCmsSigner } from '@/lib/arca-padron/cms';
import { openTicket, sealTicket, parseCacheKey } from '@/lib/arca-padron/ticket-store';
import { postSoap } from '@/lib/arca-padron/http';
import { parseXml, XML_MAX_BYTES } from '@/lib/arca-padron/xml';
describe('ARCA: cifrado, firma y límites del transporte', () => {
    const key = Buffer.alloc(32, 7), scope = 'a'.repeat(64), ticket = { token: 'SINTETICO-TOKEN', sign: 'SINTETICA-FIRMA', expiresAt: Date.now() + 3600000 };
    it('cifra tickets con nonce aleatorio y autentica clave, ámbito y contenido', () => {
        const sealed = sealTicket(ticket, key, scope);
        expect(sealed).not.toContain(ticket.token);
        expect(sealed).not.toContain(ticket.sign);
        expect(openTicket(sealed, key, scope)).toEqual(ticket);
        expect(sealTicket(ticket, key, scope)).not.toBe(sealed);
        expect(() => openTicket(sealed, Buffer.alloc(32, 8), scope)).toThrow();
        expect(() => openTicket(sealed, key, 'b'.repeat(64))).toThrow();
        const parts = sealed.split('.');
        parts[3] = Buffer.from('alterado').toString('base64');
        expect(() => openTicket(parts.join('.'), key, scope)).toThrow();
        expect(parseCacheKey(key.toString('base64'))).toEqual(key);
        expect(parseCacheKey('x')).toBeNull();
    });
    it('firma CMS verificable con OpenSSL; rechaza parejas distintas y certificados vencidos', async () => {
        const keys = forge.pki.rsa.generateKeyPair(2048);
        const cert = forge.pki.createCertificate();
        cert.publicKey = keys.publicKey;
        cert.serialNumber = '01';
        cert.validity.notBefore = new Date(Date.now() - 60000);
        cert.validity.notAfter = new Date(Date.now() + 3600000);
        cert.setSubject([{ name: 'commonName', value: 'PRUEBA SINTETICA' }]);
        cert.setIssuer(cert.subject.attributes);
        cert.sign(keys.privateKey, forge.md.sha256.create());
        const pem = forge.pki.certificateToPem(cert), privatePem = forge.pki.privateKeyToPem(keys.privateKey), sign = createCmsSigner(pem, privatePem);
        expect(sign).not.toBeNull();
        const tra = '<loginTicketRequest>PRUEBA</loginTicketRequest>';
        const cms = await sign!(tra);
        const verified = execFileSync('openssl', ['cms', '-verify', '-inform', 'DER', '-noverify'], { input: Buffer.from(cms, 'base64'), stdio: ['pipe', 'pipe', 'pipe'] });
        expect(verified.toString()).toBe(tra);
        expect(createCmsSigner(pem, forge.pki.privateKeyToPem(forge.pki.rsa.generateKeyPair(2048).privateKey))).toBeNull();
        cert.validity.notAfter = new Date(Date.now() - 1000);
        cert.sign(keys.privateKey, forge.md.sha256.create());
        expect(createCmsSigner(forge.pki.certificateToPem(cert), privatePem)).toBeNull();
    });
    it('rechaza profundidad excesiva, prefijos ajenos y cierres con distinto prefijo', () => {
        expect(() => parseXml('<a>'.repeat(65) + '</a>'.repeat(65))).toThrow();
        expect(() => parseXml('<p:a/>')).toThrow();
        expect(() => parseXml('<x:a xmlns:x="u" xmlns:y="u"></y:a>')).toThrow();
        expect(() => parseXml('<a>' + 'á'.repeat(XML_MAX_BYTES / 2) + '</a>')).toThrow();
    });
    it('corta un stream que excede el límite y lo cancela', async () => {
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(XML_MAX_BYTES)); }, cancel() { cancelled = true; } });
        const fetchImpl = (async () => new Response(stream)) as typeof fetch;
        await expect(postSoap({ fetchImpl, timeoutMs: 500 }, 'https://ejemplo.test', 'x', 'x')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
        expect(cancelled).toBe(true);
    });
    it('el timeout cubre también el cuerpo de la respuesta', async () => {
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
        await expect(postSoap({ fetchImpl: (async () => new Response(stream)) as typeof fetch, timeoutMs: 10 }, 'https://ejemplo.test', 'x', 'x')).rejects.toMatchObject({ code: 'TIMEOUT' });
        expect(cancelled).toBe(true);
    });
    it('la palabra Fault en HTML no convierte un 503 en SOAP válido', async () => {
        await expect(postSoap({ fetchImpl: (async () => new Response('<html>Fault</html>', { status: 503 })) as typeof fetch, timeoutMs: 500 }, 'https://ejemplo.test', 'x', 'x')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    });
});
