import 'server-only';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import type { CmsSigner } from './wsaa';
/** Solo memoria del servidor. La cadena de confianza se valida en WSAA; aquí se comprueban pareja, RSA y fechas. */
export function createCmsSigner(certPem: string, keyPem: string, password?: string): CmsSigner | null {
    try {
        const cert = new X509Certificate(certPem);
        const key = createPrivateKey({ key: keyPem, format: 'pem', passphrase: password });
        if (key.asymmetricKeyType !== 'rsa' || !cert.checkPrivateKey(key) || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
            return null;
        const from = Date.parse(cert.validFrom), to = Date.parse(cert.validTo);
        if (!Number.isFinite(from) || !Number.isFinite(to) || Date.now() < from || Date.now() >= to)
            return null;
        const privateKey = forge.pki.privateKeyFromPem(key.export({ type: 'pkcs1', format: 'pem' }).toString());
        return async (tra) => {
            if (Date.now() < from || Date.now() >= to)
                throw Error('certificado fuera de vigencia');
            const msg = forge.pkcs7.createSignedData();
            msg.content = forge.util.createBuffer(tra, 'utf8');
            msg.addCertificate(certPem);
            msg.addSigner({ key: privateKey, certificate: certPem, digestAlgorithm: forge.pki.oids.sha256, authenticatedAttributes: [{ type: forge.pki.oids.contentType, value: forge.pki.oids.data }, { type: forge.pki.oids.messageDigest }, { type: forge.pki.oids.signingTime, value: new Date().toISOString() }] });
            msg.sign({ detached: false });
            return forge.util.encode64(forge.asn1.toDer(msg.toAsn1()).getBytes());
        };
    }
    catch {
        return null;
    }
}
