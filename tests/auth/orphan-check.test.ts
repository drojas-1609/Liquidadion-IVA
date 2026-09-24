import { describe, it, expect, vi } from "vitest";
import { findOrphanProfiles } from "@/scripts/check-orphan-profiles";

describe("findOrphanProfiles", () => {
  it("consulta con LEFT JOIN a auth.users y devuelve las filas sin match", async () => {
    const rows = [{ id: "aaa", email: "x@y.z" }];
    const $queryRawUnsafe = vi.fn().mockResolvedValue(rows);
    const out = await findOrphanProfiles({ $queryRawUnsafe });

    expect(out).toBe(rows);
    const query = $queryRawUnsafe.mock.calls[0][0] as string;
    expect(query).toMatch(/LEFT JOIN auth\.users/);
    expect(query).toMatch(/WHERE u\.id IS NULL/);
    // solo lectura
    expect(query).not.toMatch(/INSERT|UPDATE|DELETE/i);
  });

  it("devuelve [] cuando no hay huérfanos", async () => {
    const $queryRawUnsafe = vi.fn().mockResolvedValue([]);
    expect(await findOrphanProfiles({ $queryRawUnsafe })).toEqual([]);
  });
});
