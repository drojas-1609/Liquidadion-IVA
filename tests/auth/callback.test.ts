import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const exchangeCodeForSession = vi.fn();
const verifyOtp = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: async () => ({
    auth: { exchangeCodeForSession, verifyOtp },
  }),
}));

import { GET } from "@/app/auth/callback/route";

function call(qs: string) {
  return GET(new NextRequest(`http://localhost:3000/auth/callback${qs}`));
}

beforeEach(() => {
  exchangeCodeForSession.mockReset().mockResolvedValue({ error: null });
  verifyOtp.mockReset().mockResolvedValue({ error: null });
});

describe("/auth/callback", () => {
  it("flujo code: intercambia y redirige a next interno", async () => {
    const res = await call("?code=abc123&next=%2Fclients");
    expect(exchangeCodeForSession).toHaveBeenCalledWith("abc123");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3000/clients");
  });

  it("flujo code sin next: redirige a la raíz", async () => {
    const res = await call("?code=abc123");
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
  });

  it("flujo token_hash: verifyOtp con el type recibido", async () => {
    const res = await call("?token_hash=xyz&type=recovery&next=%2Fupdate-password");
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: "xyz", type: "recovery" });
    expect(res.headers.get("location")).toBe("http://localhost:3000/update-password");
  });

  it("type desconocido: 400 y no toca Supabase", async () => {
    const res = await call("?token_hash=xyz&type=bogus");
    expect(res.status).toBe(400);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("sin parámetros válidos: 400", async () => {
    const res = await call("");
    expect(res.status).toBe(400);
  });

  it("error de intercambio: redirige a /login?error=auth", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: { message: "bad code" } });
    const res = await call("?code=bad");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=auth");
  });

  it("next absoluto/externo se descarta -> raíz del origen confiable", async () => {
    const res = await call("?code=abc&next=https%3A%2F%2Fevil.com%2Fx");
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
  });
});
