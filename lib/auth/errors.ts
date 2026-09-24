import { NextResponse } from "next/server";

/**
 * Contrato de errores de auth/authz (Tarea 3A + 3B).
 *
 * Política D4:
 *  - recurso de OTRA organización  -> 404 (NotFoundError): no se revela que existe.
 *  - recurso de la organización propia, rol insuficiente -> 403 (ForbiddenError).
 *  - sin sesión -> 401 (UnauthenticatedError).
 *
 * Tarea 3B agrega:
 *  - 403 NO_PROFILE                       (claims válidos sin fila Profile)
 *  - 403 NO_ORGANIZATION                  (Profile sin Membership)
 *  - 409 ORGANIZATION_SELECTION_REQUIRED  (>1 Membership, sin selector confiable)
 *  - 409 CONFLICT                         (violación de unicidad)
 *  - 400 BAD_REQUEST                      (JSON ausente/malformado)
 *  - 422 UNPROCESSABLE_ENTITY             (JSON válido, datos inválidos)
 *
 * Toda respuesta de error lleva `Cache-Control: no-store, max-age=0`.
 */
export type AuthErrorCode =
  | "UNAUTHENTICATED"
  | "NO_PROFILE"
  | "NO_ORGANIZATION"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "ORGANIZATION_SELECTION_REQUIRED"
  | "CONFLICT"
  | "BAD_REQUEST"
  | "UNPROCESSABLE_ENTITY"
  | "MISCONFIGURED"
  | "INTERNAL";

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number;
  /** Sólo para errores de validación (422): campo que falló. */
  readonly field?: string;

  constructor(code: AuthErrorCode, status: number, message: string, field?: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
    if (field !== undefined) this.field = field;
  }
}

export class UnauthenticatedError extends AuthError {
  constructor(message = "Necesitás iniciar sesión.") {
    super("UNAUTHENTICATED", 401, message);
    this.name = "UnauthenticatedError";
  }
}

/** Sesión válida pero sin `Profile` aprovisionado. NUNCA se degrada a acceso. */
export class NoProfileError extends AuthError {
  constructor(message = "Tu usuario no está habilitado en la aplicación.") {
    super("NO_PROFILE", 403, message);
    this.name = "NoProfileError";
  }
}

/** `Profile` sin ninguna `Membership`: no pertenece a ninguna organización. */
export class NoOrganizationError extends AuthError {
  constructor(message = "No pertenecés a ninguna organización.") {
    super("NO_ORGANIZATION", 403, message);
    this.name = "NoOrganizationError";
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
 * `Profile` con más de una `Membership` y sin selector confiable de
 * organización activa. En 3B no hay selector: la operación se rechaza.
 */
export class OrganizationSelectionRequiredError extends AuthError {
  constructor(message = "Tenés que seleccionar una organización.") {
    super("ORGANIZATION_SELECTION_REQUIRED", 409, message);
    this.name = "OrganizationSelectionRequiredError";
  }
}

/** Violación de unicidad (CUIT en la organización, período repetido, etc.). */
export class ConflictError extends AuthError {
  constructor(message = "Ya existe un registro con esos datos.") {
    super("CONFLICT", 409, message);
    this.name = "ConflictError";
  }
}

/** Cuerpo JSON ausente o malformado. */
export class BadRequestError extends AuthError {
  constructor(message = "Cuerpo de la solicitud inválido.") {
    super("BAD_REQUEST", 400, message);
    this.name = "BadRequestError";
  }
}

/** JSON válido pero semánticamente inválido. `field` identifica el campo. */
export class ValidationError extends AuthError {
  constructor(message = "Datos inválidos.", field?: string) {
    super("UNPROCESSABLE_ENTITY", 422, message, field);
    this.name = "ValidationError";
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
export function authErrorBody(
  err: AuthError,
): { error: { code: AuthErrorCode; message: string }; field?: string } {
  const body: { error: { code: AuthErrorCode; message: string }; field?: string } = {
    error: { code: err.code, message: err.message },
  };
  if (err.field !== undefined) body.field = err.field;
  return body;
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
