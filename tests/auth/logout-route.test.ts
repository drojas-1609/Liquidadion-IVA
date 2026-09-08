import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const signOut = vi.fn().mockResolvedValue({ error: null });
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: async () => ({ auth: { signOut } }),
}));

import { GET, POST } from "@/app/logout/route";

beforeEach(() => signOut.mockClear());

describe("/logout", () => {
  it("GET responde 405 y anuncia Allow: POST", () => {
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("POST cierra sesión y redirige (303) a /login en un origen confiable", async () => {
    const res = await POST(new NextRequest("http://localhost:3000/logout", { method: "POST" }));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3000/login");
  });

  it("POST redirige a /login aunque signOut falle", async () => {
    signOut.mockRejectedValueOnce(new Error("no session"));
    const res = await POST(new NextRequest("http://localhost:3000/logout", { method: "POST" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/login");
  });
});
