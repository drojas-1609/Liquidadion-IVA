import "server-only";

import { NextResponse } from "next/server";
import { redirect, notFound } from "next/navigation";
import { Prisma, type Role } from "@prisma/client";

import prisma from "@/lib/prisma";
import { getAuthClaims } from "@/lib/auth/claims";
import { roleAllows } from "@/lib/auth/roles";
import {
  isAuthError,
  authErrorResponse,
  UnauthenticatedError,
  NoProfileError,
  NoOrganizationError,
  ForbiddenError,
  NotFoundError,
  OrganizationSelectionRequiredError,
  ConflictError,
  BadRequestError,
} from "@/lib/auth/errors";

/**
 * Capa central de autorización (Tarea 3B). Todo acceso a datos de negocio en
 * `app/**` pasa por acá. Fail-closed: cualquier duda -> se niega.
 *
 * Orden canónico en un handler API (ver §7.1 del brief):
 *   1. requireAuthenticatedProfile()        -> 401 / 503 / 403 NO_PROFILE
 *   2. resolveActiveOrganization(profileId) -> 403 NO_ORGANIZATION / 409
 *   3. requireOrganizationRole(...)         -> 403 FORBIDDEN  (si el permiso NO
 *                                              depende de un recurso concreto)
 *   4. parseJsonBody(request)               -> 400 BAD_REQUEST
 *   5. validación semántica                 -> 422
 *   6. requireClientAccess / requirePeriodAccess -> 404 / 403
 *   7. prisma.$transaction(negocio + AuditLog)   -> 201 / 409 CONFLICT / 500
 *
 * D4: un recurso de OTRA organización responde EXACTAMENTE igual que uno
 * inexistente (404 NOT_FOUND, mismo cuerpo).
 */

/** Subconjunto de PrismaClient que necesita esta capa; inyectable en tests. */
export type AuthzDb = Pick<typeof prisma, "profile" | "membership" | "client" | "period">;

const defaultDb = () => prisma as AuthzDb;

// ── requireAuthenticatedProfile ───────────────────────────────────────────

export interface ProfileIdentity {
  /** Profile.id === auth.users.id (UUID). Única clave de identidad. */
  profileId: string;
  authUserId: string;
  email: string | null;
}

/**
 * Identidad autenticada + `Profile` aprovisionado.
 * - sin config de Auth  -> MisconfiguredError (503) [propagada por getAuthClaims]
 * - sin sesión válida   -> UnauthenticatedError (401)
 * - sin fila Profile    -> NoProfileError (403 NO_PROFILE)
 */
export async function requireAuthenticatedProfile(
  opts: { db?: AuthzDb } = {},
): Promise<ProfileIdentity> {
  const db = opts.db ?? defaultDb();
  const claims = await getAuthClaims();
  if (!claims) throw new UnauthenticatedError();

  const profile = await db.profile.findUnique({
    where: { id: claims.sub },
    select: { id: true, email: true },
  });
  if (!profile) throw new NoProfileError();

  return {
    profileId: profile.id,
    authUserId: profile.id,
    email: profile.email ?? claims.email ?? null,
  };
}

// ── resolveActiveOrganization ─────────────────────────────────────────────

export interface ActiveOrg {
  organizationId: string;
  role: Role;
}

/**
 * Resuelve la organización activa a partir de las Membership del Profile.
 * - 0 memberships  -> NoOrganizationError (403 NO_ORGANIZATION)
 * - 1 membership   -> se resuelve automáticamente
 * - >1 membership  -> OrganizationSelectionRequiredError (409). En 3B NO hay
 *   selector confiable: ningún organizationId de body/query/form se considera.
 */
export async function resolveActiveOrganization(
  profileId: string,
  opts: { db?: AuthzDb } = {},
): Promise<ActiveOrg> {
  const db = opts.db ?? defaultDb();
  const memberships = await db.membership.findMany({
    where: { profileId },
    select: { organizationId: true, role: true },
  });
  if (memberships.length === 0) throw new NoOrganizationError();
  if (memberships.length > 1) throw new OrganizationSelectionRequiredError();
  return { organizationId: memberships[0].organizationId, role: memberships[0].role };
}

// ── requireOrganizationRole ───────────────────────────────────────────────

/**
 * Exige Membership en `organizationId` con rol en `allowed`.
 * - sin Membership   -> NotFoundError (404). D4: no revela que la org existe.
 * - rol no permitido -> ForbiddenError (403).
 */
export async function requireOrganizationRole(
  profileId: string,
  organizationId: string,
  allowed: readonly Role[],
  opts: { db?: AuthzDb } = {},
): Promise<ActiveOrg> {
  const db = opts.db ?? defaultDb();
  const membership = await db.membership.findUnique({
    where: { profileId_organizationId: { profileId, organizationId } },
    select: { role: true },
  });
  if (!membership) throw new NotFoundError();
  if (!roleAllows(allowed, membership.role)) throw new ForbiddenError();
  return { organizationId, role: membership.role };
}

// ── requireClientAccess ───────────────────────────────────────────────────

export interface ClientAccessRow {
  id: string;
  organizationId: string;
  name: string;
  cuit: string;
  condition: string;
  address: string | null;
  defaultIibbRate: Prisma.Decimal;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClientAccess extends ActiveOrg {
  profileId: string;
  client: ClientAccessRow;
}

/**
 * Acceso a un Client concreto. 404 si no existe O es de otra organización
 * (respuesta idéntica). 403 si el rol no alcanza en la organización del Client.
 */
export async function requireClientAccess(
  profileId: string,
  clientId: string,
  allowed: readonly Role[],
  opts: { db?: AuthzDb } = {},
): Promise<ClientAccess> {
  const db = opts.db ?? defaultDb();
  const client = await db.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      organizationId: true,
      name: true,
      cuit: true,
      condition: true,
      address: true,
      defaultIibbRate: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!client) throw new NotFoundError();
  const org = await requireOrganizationRole(profileId, client.organizationId, allowed, { db });
  return { profileId, organizationId: org.organizationId, role: org.role, client };
}

// ── requirePeriodAccess ───────────────────────────────────────────────────

export interface PeriodAccessRow {
  id: string;
  clientId: string;
  organizationId: string;
}

export interface PeriodAccess extends ActiveOrg {
  profileId: string;
  period: PeriodAccessRow;
}

/**
 * Acceso a un Period concreto. 404 si no existe, es de otra organización, o su
 * `clientId` no coincide con `expectClientId` (cuando se pasa: cruce
 * padre/hijo del segmento [id] de la URL). 403 por rol.
 *
 * `Period.organizationId` es columna directa (post-migración 3B): no hace falta
 * saltar por Client.
 */
export async function requirePeriodAccess(
  profileId: string,
  periodId: string,
  allowed: readonly Role[],
  opts: { db?: AuthzDb; expectClientId?: string } = {},
): Promise<PeriodAccess> {
  const db = opts.db ?? defaultDb();
  const period = await db.period.findUnique({
    where: { id: periodId },
    select: { id: true, clientId: true, organizationId: true },
  });
  if (!period) throw new NotFoundError();
  if (opts.expectClientId !== undefined && period.clientId !== opts.expectClientId) {
    throw new NotFoundError();
  }
  const org = await requireOrganizationRole(profileId, period.organizationId, allowed, { db });
  return { profileId, organizationId: org.organizationId, role: org.role, period };
}

// ── parseJsonBody ─────────────────────────────────────────────────────────

/**
 * Lee el body JSON. Cuerpo ausente / vacío / malformado -> BadRequestError
 * (400). SÓLO se llama DESPUÉS de resolver sesión + Profile + organización.
 */
export async function parseJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BadRequestError();
  }
}

// ── withApiAuthz ──────────────────────────────────────────────────────────

const NO_STORE = "no-store, max-age=0";

/**
 * Envuelve un handler de ruta API:
 *  - captura AuthError -> respuesta de su status (cuerpo estable, sin fugas).
 *  - captura Prisma P2002 (unicidad) -> 409 CONFLICT genérico.
 *  - cualquier otro error -> 500 INTERNAL genérico (se loguea sólo el nombre
 *    de la clase, nunca el mensaje, que podría traer cadenas de conexión).
 *  - garantiza Cache-Control: no-store en toda respuesta.
 */
export function withApiAuthz<Ctx extends unknown[]>(
  handler: (req: Request, ...ctx: Ctx) => Promise<NextResponse>,
): (req: Request, ...ctx: Ctx) => Promise<NextResponse> {
  return async (req: Request, ...ctx: Ctx): Promise<NextResponse> => {
    try {
      const res = await handler(req, ...ctx);
      if (!res.headers.get("cache-control")) res.headers.set("Cache-Control", NO_STORE);
      return res;
    } catch (err) {
      if (isAuthError(err)) return authErrorResponse(err);
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return authErrorResponse(new ConflictError());
      }
      console.error(
        "[withApiAuthz] error no clasificado:",
        err instanceof Error ? err.name : typeof err,
      );
      return authErrorResponse(err); // -> 500 INTERNAL genérico + no-store
    }
  };
}

// ── guardPage ─────────────────────────────────────────────────────────────

export type PageAccessNoticeKind =
  | "no-profile"
  | "no-organization"
  | "org-selection"
  | "forbidden"
  | "misconfigured";

export type GuardResult<T> =
  | { ok: true; data: T }
  | { ok: false; notice: PageAccessNoticeKind };

const PAGE_NOTICE: Partial<Record<string, PageAccessNoticeKind>> = {
  NO_PROFILE: "no-profile",
  NO_ORGANIZATION: "no-organization",
  ORGANIZATION_SELECTION_REQUIRED: "org-selection",
  FORBIDDEN: "forbidden",
  MISCONFIGURED: "misconfigured",
};

/**
 * Para páginas SSR. Ejecuta `fn` (que corre los helpers de authz + la consulta)
 * y traduce los AuthError:
 *  - UNAUTHENTICATED -> redirect("/login")
 *  - NOT_FOUND       -> notFound()
 *  - resto           -> { ok: false, notice } para que la página renderice
 *                       <AccessNotice> sin datos fiscales.
 * Los throws de redirect()/notFound() se propagan (los captura Next).
 */
export async function guardPage<T>(fn: () => Promise<T>): Promise<GuardResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (!isAuthError(err)) throw err;
    if (err.code === "UNAUTHENTICATED") redirect("/login");
    if (err.code === "NOT_FOUND") notFound();
    const notice = PAGE_NOTICE[err.code];
    if (!notice) throw err;
    return { ok: false, notice };
  }
}
