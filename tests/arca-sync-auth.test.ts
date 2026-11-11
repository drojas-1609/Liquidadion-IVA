import { afterEach, describe, expect, it, vi } from "vitest";
import { syncAuthorized } from "@/lib/arca-sync/auth";
import { currentSyncIdentity, withSyncIdentity } from "@/lib/arca-sync/identity";

afterEach(() => vi.unstubAllEnvs());

describe("identidad limitada del conector ARCA", () => {
    it("rechaza secretos ausentes, cortos y diferentes", () => {
        vi.stubEnv("ARCA_SYNC_CONNECTOR_TOKEN", "");
        expect(syncAuthorized("Bearer anything")).toBe(false);
        vi.stubEnv("ARCA_SYNC_CONNECTOR_TOKEN", "a".repeat(32));
        expect(syncAuthorized(null)).toBe(false);
        expect(syncAuthorized("Bearer " + "b".repeat(32))).toBe(false);
        expect(syncAuthorized("Bearer " + "a".repeat(32))).toBe(true);
    });

    it("aísla cada tarea concurrente y restaura la identidad al salir", async () => {
        const received = await Promise.all(["a", "b"].map((id) => withSyncIdentity({
            profileId: id, organizationId: id, periodId: id,
        }, async () => {
            await Promise.resolve();
            return currentSyncIdentity()?.periodId;
        })));
        expect(received).toEqual(["a", "b"]);
        expect(currentSyncIdentity()).toBeUndefined();
    });
});
