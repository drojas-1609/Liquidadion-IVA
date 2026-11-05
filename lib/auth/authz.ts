import "server-only";
import {localHomoRequestAllowed} from "@/lib/arca-padron/preview-gate";

import { NextResponse } from "next/server";
import { redirect, notFound } from "next/navigation";
import { Prisma, type AppModule, type ClientScope, type PeriodStatus, type Role } from "@prisma/client";

import prisma from "@/lib/prisma";
import { getAuthClaims } from "@/lib/auth/claims";
import { roleAllows } from "@/lib/auth/roles";
import { effectivePermissions, modulesAllow, type ModuleRequirement } from "@/lib/auth/permissions";
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
 *
 * Usuarios del estudio: cada solicitud relee la Membership. Sólo una membresía
 * ACTIVE autoriza (desactivar o cambiar permisos rige en la solicitud siguiente
 * aunque la persona conserve su sesión de Supabase). Además del rol:
 *  - módulo (`module`): 403 FORBIDDEN si no está habilitado;
 *  - alcance de clientes: un cliente fuera del alcance responde 404, igual que
 *    uno inexistente o de otra organización. Los listados filtran con
 *    `clientScopeWhere`.
 * `requirePeriodAccess` exige SIEMPRE el módulo IVA (todo lo que cuelga de un
 * período es liquidación de IVA) y el alcance sobre el cliente del período.
 */

/** Subconjunto de PrismaClient que necesita esta capa; inyectable en tests. */
export type AuthzDb = Pick<typeof prisma, "profile" | "membership" | "membershipClient" | "client" | "period">;

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
  /** Membership.id (para el alcance SELECTED). */
  membershipId: string;
  /** Alcance efectivo (OWNER: siempre ALL). */
  clientScope: ClientScope;
  /** Módulos efectivos (OWNER: todos). */
  modules: readonly AppModule[];
}

const MEMBERSHIP_SELECT = {
  id: true,
  organizationId: true,
  role: true,
  status: true,
  clientScope: true,
  modules: true,
} as const;

interface MembershipRow {
  id: string;
  organizationId: string;
  role: Role;
  status: string;
  clientScope: ClientScope;
  modules: AppModule[] | null;
}

function toActiveOrg(m: MembershipRow): ActiveOrg {
  const eff = effectivePermissions({
    role: m.role,
    status: "ACTIVE",
    clientScope: m.clientScope,
    modules: m.modules,
  });
  return {
    organizationId: m.organizationId,
    role: eff.role,
    membershipId: m.id,
    clientScope: eff.clientScope,
    modules: eff.modules,
  };
}

/**
 * Resuelve la organización activa a partir de las Membership ACTIVE del
 * Profile (las DISABLED no cuentan).
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
  const memberships = (await db.membership.findMany({
    where: { profileId, status: "ACTIVE" },
    select: MEMBERSHIP_SELECT,
  })) as MembershipRow[];
  const active = memberships.filter((m) => m.status === "ACTIVE");
  if (active.length === 0) throw new NoOrganizationError();
  if (active.length > 1) throw new OrganizationSelectionRequiredError();
  return toActiveOrg(active[0]);
}

// ── requireOrganizationRole ───────────────────────────────────────────────

export interface OrgAccessOptions {
  db?: AuthzDb;
  /** Módulo exigido (uno o cualquiera de la lista). Sin él: sólo rol. */
  module?: ModuleRequirement;
}

/**
 * Exige Membership ACTIVE en `organizationId` con rol en `allowed` y, si se
 * pasa, el módulo.
 * - sin Membership o DISABLED -> NotFoundError (404). D4: no revela la org.
 * - rol no permitido          -> ForbiddenError (403).
 * - módulo no habilitado      -> ForbiddenError (403).
 */
export async function requireOrganizationRole(
  profileId: string,
  organizationId: string,
  allowed: readonly Role[],
  opts: OrgAccessOptions = {},
): Promise<ActiveOrg> {
  const db = opts.db ?? defaultDb();
  const membership = (await db.membership.findUnique({
    where: { profileId_organizationId: { profileId, organizationId } },
    select: MEMBERSHIP_SELECT,
  })) as MembershipRow | null;
  if (!membership || membership.status !== "ACTIVE") throw new NotFoundError();
  if (!roleAllows(allowed, membership.role)) throw new ForbiddenError();
  const access = toActiveOrg({ ...membership, organizationId });
  if (opts.module !== undefined && !modulesAllow(access.modules, opts.module)) {
    throw new ForbiddenError();
  }
  return access;
}

// ── Alcance de clientes ───────────────────────────────────────────────────

/**
 * Filtro Prisma de los clientes visibles para `access` dentro de su
 * organización. TODO listado, búsqueda o resumen de clientes lo usa.
 */
export function clientScopeWhere(
  access: Pick<ActiveOrg, "organizationId" | "membershipId" | "clientScope">,
): Prisma.ClientWhereInput {
  if (access.clientScope === "ALL") return { organizationId: access.organizationId };
  return {
    organizationId: access.organizationId,
    memberAccess: { some: { membershipId: access.membershipId } },
  };
}

/**
 * 404 si `clientId` está fuera del alcance de `access` (mismo cuerpo que un
 * cliente inexistente). No verifica la organización del cliente: eso lo hace
 * el llamador (filtro por organizationId o requireClientAccess).
 */
export async function assertClientInScope(
  access: Pick<ActiveOrg, "membershipId" | "clientScope">,
  clientId: string,
  opts: { db?: AuthzDb } = {},
): Promise<void> {
  if (access.clientScope === "ALL") return;
  const db = opts.db ?? defaultDb();
  const row = await db.membershipClient.findUnique({
    where: { membershipId_clientId: { membershipId: access.membershipId, clientId } },
    select: { clientId: true },
  });
  if (!row) throw new NotFoundError();
}

/** Crear clientes exige alcance ALL (si no, la persona no vería lo que crea). */
export function requireAllClientsScope(access: Pick<ActiveOrg, "clientScope">): void {
  if (access.clientScope !== "ALL") throw new ForbiddenError();
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
 * Acceso a un Client concreto. 404 si no existe, es de otra organización o
 * está fuera del alcance de la persona (respuesta idéntica). 403 si el rol o el
 * módulo no alcanzan en la organización del Client.
 */
export async function requireClientAccess(
  profileId: string,
  clientId: string,
  allowed: readonly Role[],
  opts: { db?: AuthzDb; module: ModuleRequirement },
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
  const org = await requireOrganizationRole(profileId, client.organizationId, allowed, { db, module: opts.module });
  await assertClientInScope(org, client.id, { db });
  return { profileId, ...org, client };
}

// ── requirePeriodAccess ───────────────────────────────────────────────────

export interface PeriodAccessRow {
  id: string;
  clientId: string;
  organizationId: string;
  /**
   * Estado leído SIN bloqueo: sólo decide qué ofrece la UI. La autoridad es
   * `lockPeriodForWrite` (lib/period-lock), que lo relee bajo el FOR UPDATE.
   */
  status: PeriodStatus;
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
 *
 * Exige el módulo IVA y que el cliente del período esté en el alcance (fuera
 * del alcance: 404, igual que inexistente).
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
    select: { id: true, clientId: true, organizationId: true, status: true },
  });
  if (!period) throw new NotFoundError();
  if (opts.expectClientId !== undefined && period.clientId !== opts.expectClientId) {
    throw new NotFoundError();
  }
  const org = await requireOrganizationRole(profileId, period.organizationId, allowed, { db, module: "IVA" });
  await assertClientInScope(org, period.clientId, { db });
  return { profileId, ...org, period };
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
      if(process.env.ARCA_LOCAL_HOMO==='1'&&!localHomoRequestAllowed(req.method,new URL(req.url).pathname,req.headers.get('host')??new URL(req.url).host)){
        return NextResponse.json({error:{code:'LOCAL_HOMO_READ_ONLY',message:'Prueba local: guardar y modificar datos está deshabilitado.'}},{status:403,headers:{'Cache-Control':NO_STORE}});
      }
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
