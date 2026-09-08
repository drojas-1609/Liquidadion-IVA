import { describe, it, expect } from "vitest";
import {
  AuthError,
  UnauthenticatedError,
  ForbiddenError,
  NotFoundError,
  isAuthError,
  authErrorBody,
  authErrorResponse,
} from "@/lib/auth/errors";

describe("contrato de errores de auth (D4)", () => {
  it("cada error trae code + status coherentes", () => {
    expect(new UnauthenticatedError()).toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    expect(new ForbiddenError()).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(new NotFoundError()).toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("son instancias de AuthError y Error", () => {
    for (const e of [new UnauthenticatedError(), new ForbiddenError(), new NotFoundError()]) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e).toBeInstanceOf(Error);
      expect(isAuthError(e)).toBe(true);
    }
    expect(isAuthError(new Error("x"))).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });

  it("D4: otra organización => 404, no 403 (no revela existencia)", () => {
    const crossOrg = new NotFoundError();
    expect(crossOrg.status).toBe(404);
    const wrongRole = new ForbiddenError();
    expect(wrongRole.status).toBe(403);
  });

  it("authErrorBody produce un cuerpo JSON estable", () => {
    expect(authErrorBody(new ForbiddenError("nop"))).toEqual({
      error: { code: "FORBIDDEN", message: "nop" },
    });
  });

  it("authErrorResponse mapea AuthError a su status y lo demás a 500", async () => {
    const r403 = authErrorResponse(new ForbiddenError());
    expect(r403.status).toBe(403);
    expect(await r403.json()).toEqual({
      error: { code: "FORBIDDEN", message: "No tenés permisos para esta operación." },
    });

    const r500 = authErrorResponse(new Error("boom"));
    expect(r500.status).toBe(500);
    expect((await r500.json()).error.code).toBe("INTERNAL");
  });
});
