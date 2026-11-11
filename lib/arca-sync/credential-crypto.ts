import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type FiscalCredential = { cuit: string; password: string };
type Scope = { clientId: string; organizationId: string; targetCuit: string };

export function credentialKey() {
    const value = process.env.ARCA_CLIENT_CREDENTIAL_KEY;
    return value && /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, "hex") : null;
}

function associatedData(scope: Scope) {
    return Buffer.from(JSON.stringify([scope.organizationId, scope.clientId, scope.targetCuit]));
}

export function sealCredential(credential: FiscalCredential, scope: Scope, key: Buffer) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(associatedData(scope));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(credential), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

export function openCredential(envelope: string, scope: Scope, key: Buffer): FiscalCredential {
    const bytes = Buffer.from(envelope, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAAD(associatedData(scope));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
}
