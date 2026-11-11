import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { openCredential, sealCredential } from "@/lib/arca-sync/credential-crypto";

it("cifra cada actualización y rechaza copiar el secreto a otro cliente o CUIT", () => {
    const key = randomBytes(32);
    const scope = { organizationId: "org", clientId: "cliente", targetCuit: "30700000000" };
    const credential = { cuit: "20700000000", password: "clave sintética" };
    const envelope = sealCredential(credential, scope, key);
    expect(envelope).not.toBe(sealCredential(credential, scope, key));
    expect(openCredential(envelope, scope, key)).toEqual(credential);
    expect(() => openCredential(envelope, { ...scope, clientId: "otro" }, key)).toThrow();
    expect(() => openCredential(envelope, { ...scope, organizationId: "otra" }, key)).toThrow();
    expect(() => openCredential(envelope, { ...scope, targetCuit: "30700000001" }, key)).toThrow();
    expect(() => openCredential(envelope, scope, randomBytes(32))).toThrow();
});
