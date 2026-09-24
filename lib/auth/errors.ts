import { NextResponse } from "next/server";

/**
 * Contrato de errores de auth/authz.
 *
 * Política D4:
 *  - recurso de OTRA organización  -> 404 (NotFoundError): no se revela que existe.
 *  - recurso de la organización propia, rol insuficiente -> 403 (ForbiddenError).
 *  - sin sesión -> 401 (UnauthenticatedError).
 *
 * En 3A estas clases se definen y se testean; el cableado en los handlers es 3B.
 */
export type AuthErrorCode = "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "MISCONFIGURED";

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number;

  constructor(code: AuthErrorCode, status: number, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

export class UnauthenticatedError extends AuthError {
  constructor(message = "Necesitás iniciar sesión.") {
    super("UNAUTHENTICATED", 401, message);
    this.name = "UnauthenticatedError";
  }
}

export class ForbiddenError extends AuthError {
  constructor(message = "No tenés permisos para esta operación.") {
    super("FORBIDDEN", 403, message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AuthError {
  constructor(message = "No encontrado.") {
    super("NOT_FOUND", 404, message);
    this.name = "NotFoundError";
  }
}

/**
 * Configuración de autenticación ausente o inválida. NUNCA se debe degradar a
 * acceso anónimo: se responde 503 y se niega el acceso.
 */
export class MisconfiguredError extends AuthError {
  constructor(message = "Servicio de autenticación no disponible.") {
    super("MISCONFIGURED", 503, message);
    this.name = "MisconfiguredError";
  }
}

export function isAuthError(value: unknown): value is AuthError {
  return value instanceof AuthError;
}

/** Cuerpo JSON estable para las respuestas de error de las rutas API. */
export function authErrorBody(err: AuthError): { error: { code: AuthErrorCode; message: string } } {
  return { error: { code: err.code, message: err.message } };
}

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

export function authErrorResponse(err: unknown): NextResponse {
  if (isAuthError(err)) {
    return NextResponse.json(authErrorBody(err), { status: err.status, headers: NO_STORE });
  }
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "Error interno." } },
    { status: 500, headers: NO_STORE },
  );
}
