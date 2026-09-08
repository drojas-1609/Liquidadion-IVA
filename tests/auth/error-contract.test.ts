import { describe, it, expect } from "vitest";
import {
  AuthError,
  UnauthenticatedError,
  NoProfileError,
  NoOrganizationError,
  ForbiddenError,
  NotFoundError,
  OrganizationSelectionRequiredError,
  ConflictError,
  BadRequestError,
  ValidationError,
  MisconfiguredError,
  isAuthError,
  authErrorBody,
  authErrorResponse,
} from "@/lib/auth/errors";

describe("contrato de errores de auth (D4)", () => {
  it("cada error trae code + status coherentes", () => {
    expect(new UnauthenticatedError()).toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    expect(new ForbiddenError()).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(new NotFoundError()).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(new MisconfiguredError()).toMatchObject({ code: "MISCONFIGURED", status: 503 });
  });

  it("son instancias de AuthError y Error", () => {
    for (const e of [
      new UnauthenticatedError(),
      new ForbiddenError(),
      new NotFoundError(),
      new MisconfiguredError(),
    ]) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e).toBeInstanceOf(Error);
      expect(isAuthError(e)).toBe(true);
    }
    expect(isAuthError(new Error("x"))).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });

  it("MisconfiguredError -> 503 con Cache-Control: no-store", async () => {
    const res = authErrorResponse(new MisconfiguredError());
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect((await res.json()).error.code).toBe("MISCONFIGURED");
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

describe("contrato de errores de authz (Tarea 3B)", () => {
  it("cada error nuevo trae code + status exactos del brief", () => {
    expect(new NoProfileError()).toMatchObject({ code: "NO_PROFILE", status: 403 });
    expect(new NoOrganizationError()).toMatchObject({ code: "NO_ORGANIZATION", status: 403 });
    expect(new OrganizationSelectionRequiredError()).toMatchObject({
      code: "ORGANIZATION_SELECTION_REQUIRED",
      status: 409,
    });
    expect(new ConflictError()).toMatchObject({ code: "CONFLICT", status: 409 });
    expect(new BadRequestError()).toMatchObject({ code: "BAD_REQUEST", status: 400 });
    expect(new ValidationError()).toMatchObject({ code: "UNPROCESSABLE_ENTITY", status: 422 });
  });

  it("todos son AuthError y los detecta isAuthError", () => {
    for (const e of [
      new NoProfileError(),
      new NoOrganizationError(),
      new OrganizationSelectionRequiredError(),
      new ConflictError(),
      new BadRequestError(),
      new ValidationError(),
    ]) {
      expect(e).toBeInstanceOf(AuthError);
      expect(isAuthError(e)).toBe(true);
    }
  });

  it("ValidationError transporta `field` y authErrorBody lo expone", () => {
    const err = new ValidationError("mes inválido", "month");
    expect(err.field).toBe("month");
    expect(authErrorBody(err)).toEqual({
      error: { code: "UNPROCESSABLE_ENTITY", message: "mes inválido" },
      field: "month",
    });
  });

  it("los errores sin `field` no agregan la clave al cuerpo", () => {
    expect(authErrorBody(new ConflictError("x"))).toEqual({
      error: { code: "CONFLICT", message: "x" },
    });
  });

  it("authErrorResponse: cada error nuevo -> su status + Cache-Control no-store", async () => {
    for (const [err, status, code] of [
      [new NoProfileError(), 403, "NO_PROFILE"],
      [new NoOrganizationError(), 403, "NO_ORGANIZATION"],
      [new OrganizationSelectionRequiredError(), 409, "ORGANIZATION_SELECTION_REQUIRED"],
      [new ConflictError(), 409, "CONFLICT"],
      [new BadRequestError(), 400, "BAD_REQUEST"],
      [new ValidationError("x", "f"), 422, "UNPROCESSABLE_ENTITY"],
    ] as const) {
      const res = authErrorResponse(err);
      expect(res.status, code).toBe(status);
      expect(res.headers.get("cache-control"), code).toBe("no-store, max-age=0");
      expect((await res.json()).error.code, code).toBe(code);
    }
  });

  it("ningún mensaje por defecto filtra detalles internos", () => {
    for (const e of [
      new NoProfileError(),
      new NoOrganizationError(),
      new OrganizationSelectionRequiredError(),
      new ConflictError(),
      new BadRequestError(),
      new ValidationError(),
    ]) {
      expect(e.message).not.toMatch(/prisma|P20\d\d|constraint|postgres|token|eyJ/i);
    }
  });
});
