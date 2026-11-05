import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Usuarios del estudio contra un PostgreSQL 17 LOCAL Y DESCARTABLE (no mocks
 * de base): migración compatible con la membresía existente, dos usuarias
 * SINTÉTICAS con permisos distintos, intentos por URL/API a otro cliente y a
 * otra organización, revocación con la sesión abierta, invitaciones
 * simultáneas al llegar al cupo y protección del propietario (aplicación +
 * trigger de la base).
 *
 * Sólo corre con PR17_LOCAL_PG_URL apuntando a 127.0.0.1/localhost (lo arma
 * scripts/pg-local-regression.sh). Nunca usa credenciales remotas ni envía
 * correos: el envío está simulado. Datos SINTÉTICOS (dominio .test).
 */

const RAW_URL = process.env.PR17_LOCAL_PG_URL ?? "";
function localOnly(raw: string): string | null {
  if (!raw) return null;
  const u = new URL(raw);
  if (!["127.0.0.1", "localhost"].includes(u.hostname)) throw new Error("PR17_LOCAL_PG_URL debe ser local (127.0.0.1/localhost)");
  if (/supabase|pooler|bqqruaikbqculvmtirvy|esyfpakajthdifhnhcew/i.test(raw)) throw new Error("PR17_LOCAL_PG_URL no puede apuntar a Supabase");
  return raw;
}
const URL_LOCAL = localOnly(RAW_URL);

const H = vi.hoisted(() => ({
  db: { current: null as unknown },
  claims: { value: null as unknown },
  sent: [] as string[],
  authIds: new Map<string, string>(),
  mailDelayMs: 0,
}));
vi.mock("@/lib/prisma", () => ({
  get default() {
    return H.db.current;
  },
}));
vi.mock("@/lib/auth/claims", () => ({ getAuthClaims: async () => H.claims.value }));
vi.mock("@/lib/users/invitation-mailer", () => ({
  sendInvitationEmail: async (email: string) => {
    if (H.mailDelayMs) await new Promise((r) => setTimeout(r, H.mailDelayMs));
    H.sent.push(email);
    return { status: "SENT", channel: "invite", authUserId: H.authIds.get(email) ?? null };
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOTFOUND_PAGE");
  },
  useRouter: () => ({ push: () => undefined, refresh: () => undefined, replace: () => undefined }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { GET as listClients, POST as createClient } from "@/app/api/clients/route";
import { PATCH as patchClient } from "@/app/api/clients/[id]/route";
import { GET as exportLiquidation } from "@/app/api/client/[id]/period/[periodId]/export/route";
import { POST as createPeriod } from "@/app/api/periods/route";
import { POST as createTax } from "@/app/api/taxes/route";
import { POST as invite } from "@/app/api/organization/invitations/route";
import { POST as resend } from "@/app/api/organization/invitations/[id]/resend/route";
import { POST as revoke } from "@/app/api/organization/invitations/[id]/revoke/route";
import { PATCH as patchMember } from "@/app/api/organization/members/[id]/route";
import { POST as disableMember } from "@/app/api/organization/members/[id]/disable/route";
import { POST as enableMember } from "@/app/api/organization/members/[id]/enable/route";
import { acceptInvitation } from "@/lib/users/service";
import ClientsPage from "@/app/(app)/clients/page";
import ClientDashboard from "@/app/(app)/client/[id]/dashboard/page";
import PeriodPage from "@/app/(app)/client/[id]/period/[periodId]/page";
import UsersSettingsPage from "@/app/(app)/settings/users/page";
import { AccessNotice } from "@/app/_components/access-notice";

const OWNER_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const OWNER_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const ANA = "aaaaaaaa-0000-4000-8000-00000000a0a1"; // Contable, sólo cliente c1, sólo IVA
const BEA = "aaaaaaaa-0000-4000-8000-00000000b0b1"; // Consulta, todos los clientes, Clientes + IVA
const ANA_EMAIL = "ana.sintetica@estudio.test";
const BEA_EMAIL = "bea.sintetica@estudio.test";
const claims = (sub: string, email: string) => ({ sub, email, authRole: "authenticated", raw: {} });
const as = (sub: string, email = `${sub}@estudio.test`) => {
  H.claims.value = claims(sub, email);
};

const json = (method: string, url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  });
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noticeOf = (el: any): string | null => (el && el.type === AccessNotice ? el.props.notice : null);
const html = (el: unknown) => renderToStaticMarkup(el as React.ReactElement);

describe.skipIf(!URL_LOCAL)("PostgreSQL local: usuarios del estudio, permisos y cupos", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = new PrismaClient({ datasourceUrl: URL_LOCAL! });
    H.db.current = db;
    const [{ addr }] = await db.$queryRaw<{ addr: string | null }[]>`SELECT inet_server_addr()::text AS addr`;
    expect(addr).toBe("127.0.0.1/32");
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(
      `TRUNCATE "MembershipClient", "OrganizationInvitation", "AuditLog", "TaxRecord", "Invoice", "Period", "ClientActivityRate", "ClientActivity", "ClientJurisdiction", "Client", "Membership", "Profile", "Organization" CASCADE`,
    );
    H.sent.length = 0;
    H.authIds = new Map([
      [ANA_EMAIL, ANA],
      [BEA_EMAIL, BEA],
    ]);
    H.mailDelayMs = 0;
    await db.organization.createMany({ data: [{ id: "org_a", name: "Estudio A sintético" }, { id: "org_b", name: "Estudio B sintético" }] });
    await db.profile.createMany({ data: [{ id: OWNER_A, email: "owner.a@estudio.test" }, { id: OWNER_B, email: "owner.b@estudio.test" }] });
    // Membresías "previas": SÓLO las columnas que existían antes de la migración.
    await db.$executeRawUnsafe(
      `INSERT INTO "Membership"("id","profileId","organizationId","role","updatedAt") VALUES ('m_owner_a','${OWNER_A}','org_a','OWNER',now()),('m_owner_b','${OWNER_B}','org_b','OWNER',now())`,
    );
    const base = { condition: "Responsable Inscripto" };
    await db.client.createMany({
      data: [
        { id: "c1", organizationId: "org_a", name: "Cliente Uno", cuit: "30-11111111-4", ...base },
        { id: "c2", organizationId: "org_a", name: "Cliente Dos", cuit: "30-22222222-8", ...base },
        { id: "c3", organizationId: "org_a", name: "Cliente Tres", cuit: "30-33333333-1", ...base },
        { id: "cb", organizationId: "org_b", name: "Cliente Ajeno", cuit: "30-11111111-4", ...base },
      ],
    });
    await db.period.createMany({
      data: [
        { id: "p1", clientId: "c1", organizationId: "org_a", month: 1, year: 2026 },
        { id: "p2", clientId: "c2", organizationId: "org_a", month: 1, year: 2026 },
        { id: "pb", clientId: "cb", organizationId: "org_b", month: 1, year: 2026 },
      ],
    });
  });

  const inviteBody = (email: string, extra: Record<string, unknown> = {}) => ({
    email,
    role: "VIEWER",
    clientScope: "ALL",
    modules: ["IVA"],
    ...extra,
  });

  /** Invita y acepta como lo haría la persona (servicio de aceptación con su identidad verificada). */
  async function onboard(sub: string, email: string, perms: Record<string, unknown>) {
    as(OWNER_A);
    const res = await invite(json("POST", "/api/organization/invitations", { email, ...perms }));
    expect(res.status).toBe(201);
    expect((await res.json()).delivery).toBe("SENT");
    await acceptInvitation({ sub, email });
    return (await db.membership.findFirstOrThrow({ where: { profileId: sub } })).id;
  }

  async function seedTwoUsers() {
    const ana = await onboard(ANA, ANA_EMAIL, { role: "ACCOUNTANT", clientScope: "SELECTED", clientIds: ["c1"], modules: ["IVA"] });
    const bea = await onboard(BEA, BEA_EMAIL, { role: "VIEWER", clientScope: "ALL", modules: ["CLIENTS", "IVA"] });
    return { ana, bea };
  }

  const clientNames = async () => {
    const res = await listClients(json("GET", "/api/clients"));
    if (res.status !== 200) return res.status;
    return ((await res.json()) as { name: string }[]).map((c) => c.name).sort();
  };
  const exportStatus = async (clientId: string, periodId: string) =>
    (await exportLiquidation(json("GET", `/api/client/${clientId}/period/${periodId}/export`), ctx({ id: clientId, periodId }))).status;

  it("Operador edita su cliente y carga IVA, sin altas de clientes ni gestión de usuarios", async () => {
    await onboard(ANA, ANA_EMAIL, { role: "OPERATOR", clientScope: "SELECTED", clientIds: ["c1"], modules: ["CLIENTS", "IVA"] });
    as(ANA, ANA_EMAIL);
    expect(await clientNames()).toEqual(["Cliente Uno"]);
    expect(html(await ClientsPage())).not.toContain("Nuevo Cliente");
    const client = await db.client.findUniqueOrThrow({ where: { id: "c1" } });
    expect((await patchClient(json("PATCH", "/api/clients/c1", {
      name: "Cliente actualizado", expectedUpdatedAt: client.updatedAt.toISOString(),
    }), ctx({ id: "c1" }))).status).toBe(200);
    expect((await db.client.findUniqueOrThrow({ where: { id: "c1" } })).name).toBe("Cliente actualizado");
    expect((await createTax(json("POST", "/api/taxes", { periodId: "p1", date: "2026-01-10", type: "RETENCION IVA", amount: "10.00" }))).status).toBe(201);
    expect((await createClient(json("POST", "/api/clients", {}))).status).toBe(403);
    expect((await patchClient(json("PATCH", "/api/clients/c2", {}), ctx({ id: "c2" }))).status).toBe(404);
    expect((await invite(json("POST", "/api/organization/invitations", inviteBody("x@estudio.test")))).status).toBe(403);
    expect(noticeOf(await UsersSettingsPage())).toBe("forbidden");
  });

  it("migración compatible: la membresía previa del propietario queda ACTIVE/ALL/todos los módulos y sigue administrando", async () => {
    const m = await db.membership.findUniqueOrThrow({ where: { id: "m_owner_a" } });
    expect(m).toMatchObject({ status: "ACTIVE", clientScope: "ALL", modules: ["CLIENTS", "IVA", "ARCA_PADRON"], disabledAt: null });
    expect((await db.organization.findUniqueOrThrow({ where: { id: "org_a" } })).seatLimit).toBe(5);
    as(OWNER_A);
    expect(await clientNames()).toEqual(["Cliente Dos", "Cliente Tres", "Cliente Uno"]);
    expect(noticeOf(await UsersSettingsPage())).toBeNull();
    const res = await invite(json("POST", "/api/organization/invitations", inviteBody(ANA_EMAIL)));
    expect(res.status).toBe(201);
  });

  it("dos usuarias sintéticas con permisos distintos: listados, páginas, API y exportación", async () => {
    await seedTwoUsers();

    // Ana: Contable, sólo c1, sólo IVA.
    as(ANA, ANA_EMAIL);
    expect(await clientNames()).toEqual(["Cliente Uno"]);
    const page = html(await ClientsPage());
    expect(page).toContain("Cliente Uno");
    expect(page).not.toContain("Cliente Dos");
    expect(page).not.toContain("30-22222222-8");
    expect(page).not.toContain("Nuevo Cliente");
    expect(await exportStatus("c1", "p1")).not.toBe(404);
    // Otro cliente del mismo estudio por URL/API: 404 idéntico a inexistente.
    expect(await exportStatus("c2", "p2")).toBe(404);
    expect(await exportStatus("c1", "p2")).toBe(404);
    await expect(ClientDashboard({ params: Promise.resolve({ id: "c2" }) })).rejects.toThrow("NOTFOUND_PAGE");
    await expect(PeriodPage({ params: Promise.resolve({ id: "c2", periodId: "p2" }) })).rejects.toThrow("NOTFOUND_PAGE");
    const taxOther = await createTax(json("POST", "/api/taxes", { periodId: "p2", date: "2026-01-10", type: "RETENCION IVA", amount: "10.00" }));
    expect(taxOther.status).toBe(404);
    const periodOther = await createPeriod(json("POST", "/api/periods", { clientId: "c2", month: 2, year: 2026 }));
    expect(periodOther.status).toBe(404);
    // Otra organización: 404.
    expect(await exportStatus("cb", "pb")).toBe(404);
    await expect(ClientDashboard({ params: Promise.resolve({ id: "cb" }) })).rejects.toThrow("NOTFOUND_PAGE");
    // Módulo Fichas de clientes no habilitado: 403 al crear o editar fichas.
    expect((await createClient(json("POST", "/api/clients", {}))).status).toBe(403);
    expect((await patchClient(json("PATCH", "/api/clients/c1", {}), ctx({ id: "c1" }))).status).toBe(403);
    // Gestión de usuarios: sólo el propietario.
    expect((await invite(json("POST", "/api/organization/invitations", inviteBody("x@estudio.test")))).status).toBe(403);
    expect(noticeOf(await UsersSettingsPage())).toBe("forbidden");

    // Bea: Consulta, todos los clientes, Clientes + IVA.
    as(BEA, BEA_EMAIL);
    expect(await clientNames()).toEqual(["Cliente Dos", "Cliente Tres", "Cliente Uno"]);
    expect(await exportStatus("c2", "p2")).not.toBe(404);
    expect(await exportStatus("cb", "pb")).toBe(404);
    // VIEWER no carga.
    const taxBea = await createTax(json("POST", "/api/taxes", { periodId: "p2", date: "2026-01-10", type: "RETENCION IVA", amount: "10.00" }));
    expect(taxBea.status).toBe(403);
    expect(html(await ClientDashboard({ params: Promise.resolve({ id: "c2" }) }))).toContain("Períodos fiscales");
  });

  it("sin módulo IVA: el tablero no lee ni muestra períodos y las rutas del período responden 403", async () => {
    await onboard(ANA, ANA_EMAIL, { role: "ACCOUNTANT", clientScope: "ALL", modules: ["CLIENTS"] });
    as(ANA, ANA_EMAIL);
    const dash = html(await ClientDashboard({ params: Promise.resolve({ id: "c1" }) }));
    expect(dash).toContain("Cliente Uno");
    expect(dash).not.toContain("Períodos fiscales");
    expect(await exportStatus("c1", "p1")).toBe(403);
    expect(noticeOf(await PeriodPage({ params: Promise.resolve({ id: "c1", periodId: "p1" }) }))).toBe("forbidden");
  });

  it("revocación con la sesión abierta: rige en la solicitud siguiente (permisos, desactivación, reactivación)", async () => {
    const { ana } = await seedTwoUsers();
    as(ANA, ANA_EMAIL);
    expect(await clientNames()).toEqual(["Cliente Uno"]);
    expect(await exportStatus("c1", "p1")).not.toBe(404);

    // El propietario cambia el alcance de Ana a c2 (Ana conserva su sesión/claims).
    as(OWNER_A);
    const changed = await patchMember(
      json("PATCH", `/api/organization/members/${ana}`, { role: "ACCOUNTANT", clientScope: "SELECTED", clientIds: ["c2"], modules: ["IVA"] }),
      ctx({ id: ana }),
    );
    expect(changed.status).toBe(200);
    expect((await changed.json()).changed).toEqual(["clients"]);
    as(ANA, ANA_EMAIL);
    expect(await clientNames()).toEqual(["Cliente Dos"]);
    expect(await exportStatus("c1", "p1")).toBe(404);
    expect(await exportStatus("c2", "p2")).not.toBe(404);

    // Desactivación: la siguiente solicitud ya no tiene organización.
    as(OWNER_A);
    expect((await disableMember(json("POST", `/api/organization/members/${ana}/disable`), ctx({ id: ana }))).status).toBe(200);
    as(ANA, ANA_EMAIL);
    const denied = await listClients(json("GET", "/api/clients"));
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("NO_ORGANIZATION");
    expect(await exportStatus("c2", "p2")).toBe(403);
    expect(noticeOf(await ClientsPage())).toBe("no-organization");

    // Reactivación: vuelve con los permisos guardados.
    as(OWNER_A);
    expect((await enableMember(json("POST", `/api/organization/members/${ana}/enable`), ctx({ id: ana }))).status).toBe(200);
    as(ANA, ANA_EMAIL);
    expect(await clientNames()).toEqual(["Cliente Dos"]);

    // Auditoría mínima: quién, qué y sin correos ni ids de clientes.
    const audits = await db.auditLog.findMany({ where: { action: { startsWith: "member." } }, orderBy: { createdAt: "asc" } });
    expect(audits.map((a) => a.action)).toEqual([
      "member.invite",
      "member.invite_accept",
      "member.invite",
      "member.invite_accept",
      "member.permissions_change",
      "member.disable",
      "member.enable",
    ]);
    const change = audits.find((a) => a.action === "member.permissions_change")!;
    expect(change.actorProfileId).toBe(OWNER_A);
    expect(change.metadata).toEqual({
      changedFields: "clients",
      roleBefore: "ACCOUNTANT",
      roleAfter: "ACCOUNTANT",
      clientScopeBefore: "SELECTED",
      clientScopeAfter: "SELECTED",
      clientCount: 1,
      modules: "IVA",
    });
    expect(JSON.stringify(audits)).not.toMatch(/estudio\.test|"c1"|"c2"/);
  });

  it("cupo: la invitación pendiente ocupa plaza; revocar o vencer la libera; reenviar una vencida la vuelve a exigir", async () => {
    await db.organization.update({ where: { id: "org_a" }, data: { seatLimit: 2 } });
    as(OWNER_A);
    const first = await invite(json("POST", "/api/organization/invitations", inviteBody("uno@estudio.test")));
    expect(first.status).toBe(201);
    const { invitationId } = await first.json();
    const full = await invite(json("POST", "/api/organization/invitations", inviteBody("dos@estudio.test")));
    expect(full.status).toBe(409);
    expect((await full.json()).field).toBe("seats");

    expect((await revoke(json("POST", "/x"), ctx({ id: invitationId }))).status).toBe(204);
    const second = await invite(json("POST", "/api/organization/invitations", inviteBody("dos@estudio.test")));
    expect(second.status).toBe(201);
    const secondId = (await second.json()).invitationId;

    // Vencida: no ocupa plaza.
    await db.organizationInvitation.update({ where: { id: secondId }, data: { expiresAt: new Date(Date.now() - 1000), lastSentAt: null } });
    expect((await invite(json("POST", "/api/organization/invitations", inviteBody("tres@estudio.test")))).status).toBe(201);
    // Reenviar la vencida exige plaza: ya no hay.
    const again = await resend(json("POST", "/x"), ctx({ id: secondId }));
    expect(again.status).toBe(409);
    expect((await again.json()).field).toBe("seats");
  });

  it("invitaciones simultáneas al llegar al cupo: exactamente una entra (varias rondas)", async () => {
    as(OWNER_A);
    H.mailDelayMs = 5;
    for (let round = 0; round < 5; round++) {
      await db.organizationInvitation.deleteMany({});
      // Propietario + (limit - 2) pendientes => queda UNA plaza.
      await db.organization.update({ where: { id: "org_a" }, data: { seatLimit: 3 } });
      expect((await invite(json("POST", "/api/organization/invitations", inviteBody(`base${round}@estudio.test`)))).status).toBe(201);
      const results = await Promise.all(
        ["x", "y", "z", "w"].map((s) => invite(json("POST", "/api/organization/invitations", inviteBody(`${s}${round}@estudio.test`)))),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409]);
      const pending = await db.organizationInvitation.count({ where: { organizationId: "org_a", status: "PENDING" } });
      expect(pending).toBe(2);
    }
  });

  it("estudio bloqueado más de 3 s por otra operación: 409 busy (no 500) y nada escrito; luego entra", async () => {
    as(OWNER_A);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Organization" WHERE "id" = 'org_a' FOR UPDATE`;
      locked();
      await held;
    }, { maxWait: 5000, timeout: 20000 });
    await isLocked;
    const t0 = Date.now();
    const res = await invite(json("POST", "/api/organization/invitations", inviteBody(ANA_EMAIL)));
    const waited = Date.now() - t0;
    release();
    await holder;
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.field).toBe("busy");
    expect(waited).toBeGreaterThanOrEqual(2900);
    expect(waited).toBeLessThan(8000);
    expect(await db.organizationInvitation.count({ where: { email: ANA_EMAIL } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: "member.invite" } })).toBe(0);
    // SET LOCAL: al terminar la transacción la conexión vuelve a su lock_timeout.
    expect((await invite(json("POST", "/api/organization/invitations", inviteBody(ANA_EMAIL)))).status).toBe(201);
    const [{ lt }] = await db.$queryRaw<{ lt: string }[]>`SELECT current_setting('lock_timeout') AS lt`;
    expect(lt).toBe("0");
  });

  it("la misma persona invitada dos veces a la vez: una sola invitación pendiente", async () => {
    as(OWNER_A);
    const results = await Promise.all([1, 2, 3].map(() => invite(json("POST", "/api/organization/invitations", inviteBody(ANA_EMAIL)))));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await db.organizationInvitation.count({ where: { email: ANA_EMAIL, status: "PENDING" } })).toBe(1);
  });

  it("protección del propietario: aplicación (403/404) y trigger de la base", async () => {
    const { ana } = await seedTwoUsers();
    as(OWNER_A);
    const own = { role: "VIEWER", clientScope: "ALL", modules: ["IVA"] };
    expect((await patchMember(json("PATCH", "/x", own), ctx({ id: "m_owner_a" }))).status).toBe(403);
    expect((await disableMember(json("POST", "/x"), ctx({ id: "m_owner_a" }))).status).toBe(403);
    // OWNER no se asigna por invitación ni por cambio de permisos.
    expect((await invite(json("POST", "/api/organization/invitations", { ...own, email: "otro@estudio.test", role: "OWNER" }))).status).toBe(422);
    expect((await patchMember(json("PATCH", "/x", { ...own, role: "OWNER" }), ctx({ id: ana }))).status).toBe(422);
    // Propietario de OTRO estudio sobre una persona de org_a: 404 (no revela).
    as(OWNER_B);
    expect((await disableMember(json("POST", "/x"), ctx({ id: ana }))).status).toBe(404);
    expect((await patchMember(json("PATCH", "/x", own), ctx({ id: ana }))).status).toBe(404);
    // Un cliente de otro estudio no se puede asignar.
    as(OWNER_A);
    const foreign = await patchMember(json("PATCH", "/x", { ...own, clientScope: "SELECTED", clientIds: ["cb"] }), ctx({ id: ana }));
    expect(foreign.status).toBe(422);
    // La base impide dejar al estudio sin propietario activo, aunque se saltee la aplicación.
    await expect(db.membership.update({ where: { id: "m_owner_a" }, data: { status: "DISABLED" } })).rejects.toThrow();
    await expect(db.membership.update({ where: { id: "m_owner_a" }, data: { role: "ADMIN" } })).rejects.toThrow();
    await expect(db.membership.delete({ where: { id: "m_owner_a" } })).rejects.toThrow();
    // Y la FK compuesta impide asignar clientes de otro estudio.
    await expect(db.membershipClient.create({ data: { membershipId: ana, clientId: "cb", organizationId: "org_a" } })).rejects.toThrow();
    // El propietario sigue entrando y administrando.
    expect(await clientNames()).toEqual(["Cliente Dos", "Cliente Tres", "Cliente Uno"]);
    expect(noticeOf(await UsersSettingsPage())).toBeNull();
  });

  it("aceptación: correo verificado y auth.users.id deben coincidir; revocada o vencida no se acepta", async () => {
    as(OWNER_A);
    const res = await invite(json("POST", "/api/organization/invitations", inviteBody(ANA_EMAIL)));
    const { invitationId } = await res.json();
    // Otro auth.users.id con el mismo correo (no el que devolvió Supabase): rechazada.
    await expect(acceptInvitation({ sub: BEA, email: ANA_EMAIL })).rejects.toThrow();
    // Otro correo: rechazada.
    await expect(acceptInvitation({ sub: ANA, email: BEA_EMAIL })).rejects.toThrow();
    expect(await db.membership.count({ where: { profileId: { in: [ANA, BEA] } } })).toBe(0);
    expect((await revoke(json("POST", "/x"), ctx({ id: invitationId }))).status).toBe(204);
    await expect(acceptInvitation({ sub: ANA, email: ANA_EMAIL })).rejects.toThrow();
    // Ya aceptada: un segundo intento no duplica.
    const again = await invite(json("POST", "/api/organization/invitations", inviteBody(ANA_EMAIL)));
    expect(again.status).toBe(201);
    await acceptInvitation({ sub: ANA, email: ANA_EMAIL.toUpperCase() });
    await expect(acceptInvitation({ sub: ANA, email: ANA_EMAIL })).rejects.toThrow();
    expect(await db.membership.count({ where: { profileId: ANA } })).toBe(1);
    // Ya miembro: no se la puede volver a invitar.
    expect((await invite(json("POST", "/api/organization/invitations", inviteBody(ANA_EMAIL)))).status).toBe(409);
  });

  it("vencimiento: una invitación vencida no se acepta; reenviarla la renueva y entonces sí", async () => {
    as(OWNER_A);
    const { invitationId } = await (await invite(json("POST", "/api/organization/invitations", inviteBody(ANA_EMAIL)))).json();
    await db.organizationInvitation.update({ where: { id: invitationId }, data: { expiresAt: new Date(Date.now() - 1000), lastSentAt: null } });
    await expect(acceptInvitation({ sub: ANA, email: ANA_EMAIL })).rejects.toThrow(/No encontramos una invitación vigente/);
    expect(await db.membership.count({ where: { profileId: ANA } })).toBe(0);
    const before = Date.now();
    const renewed = await resend(json("POST", "/x"), ctx({ id: invitationId }));
    expect(renewed.status).toBe(200);
    const row = await db.organizationInvitation.findUniqueOrThrow({ where: { id: invitationId } });
    expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 7 * 24 * 3600 * 1000 - 5000);
    expect(row.sendCount).toBe(2);
    await acceptInvitation({ sub: ANA, email: ANA_EMAIL });
    expect((await db.membership.findFirstOrThrow({ where: { profileId: ANA } })).organizationId).toBe("org_a");
  });

  it("reenvío: enfriamiento de un minuto, sólo pendientes y sólo del propio estudio", async () => {
    as(OWNER_A);
    const { invitationId } = await (await invite(json("POST", "/api/organization/invitations", inviteBody(ANA_EMAIL)))).json();
    const tooSoon = await resend(json("POST", "/x"), ctx({ id: invitationId }));
    expect(tooSoon.status).toBe(409);
    expect(H.sent).toEqual([ANA_EMAIL]);
    await db.organizationInvitation.update({ where: { id: invitationId }, data: { lastSentAt: new Date(Date.now() - 61_000) } });
    as(OWNER_B);
    expect((await resend(json("POST", "/x"), ctx({ id: invitationId }))).status).toBe(404);
    expect((await revoke(json("POST", "/x"), ctx({ id: invitationId }))).status).toBe(404);
    as(OWNER_A);
    expect((await resend(json("POST", "/x"), ctx({ id: invitationId }))).status).toBe(200);
    expect(H.sent).toEqual([ANA_EMAIL, ANA_EMAIL]);
    expect((await revoke(json("POST", "/x"), ctx({ id: invitationId }))).status).toBe(204);
    await db.organizationInvitation.update({ where: { id: invitationId }, data: { lastSentAt: new Date(Date.now() - 61_000) } });
    expect((await resend(json("POST", "/x"), ctx({ id: invitationId }))).status).toBe(409);
    expect((await revoke(json("POST", "/x"), ctx({ id: invitationId }))).status).toBe(409);
    expect(H.sent).toHaveLength(2);
  });

  it("correo ya registrado (Supabase no devuelve id): acepta la cuenta de ese correo verificado, en el estudio que invitó", async () => {
    H.authIds = new Map(); // cuenta preexistente: canal magiclink, authUserId null
    as(OWNER_A);
    const { invitationId } = await (
      await invite(json("POST", "/api/organization/invitations", { email: ANA_EMAIL, role: "ACCOUNTANT", clientScope: "SELECTED", clientIds: ["c2"], modules: ["IVA"] }))
    ).json();
    expect((await db.organizationInvitation.findUniqueOrThrow({ where: { id: invitationId } })).authUserId).toBeNull();
    // Profile ya existente con otro correo guardado: se actualiza; identidad = sub.
    await db.profile.create({ data: { id: ANA, email: "anterior@estudio.test" } });
    await acceptInvitation({ sub: ANA, email: ANA_EMAIL });
    const m = await db.membership.findFirstOrThrow({ where: { profileId: ANA }, include: { clientAccess: true } });
    expect(m).toMatchObject({ organizationId: "org_a", role: "ACCOUNTANT", clientScope: "SELECTED", status: "ACTIVE", modules: ["IVA"] });
    expect(m.clientAccess.map((c) => c.clientId)).toEqual(["c2"]);
    expect((await db.profile.findUniqueOrThrow({ where: { id: ANA } })).email).toBe(ANA_EMAIL);
    const inv = await db.organizationInvitation.findUniqueOrThrow({ where: { id: invitationId } });
    expect(inv).toMatchObject({ status: "ACCEPTED", authUserId: ANA });
    as(ANA, ANA_EMAIL);
    expect(await clientNames()).toEqual(["Cliente Dos"]);
  });

  it("vínculo correcto: invitaciones del mismo correo en dos estudios no se mezclan; activa en otro estudio no acepta", async () => {
    H.authIds = new Map();
    as(OWNER_A);
    const a = await (await invite(json("POST", "/api/organization/invitations", inviteBody(ANA_EMAIL, { role: "ACCOUNTANT" })))).json();
    as(OWNER_B);
    const b = await (await invite(json("POST", "/api/organization/invitations", inviteBody(ANA_EMAIL, { modules: ["CLIENTS"] })))).json();
    // Dos vigentes: no se elige por ella.
    await expect(acceptInvitation({ sub: ANA, email: ANA_EMAIL })).rejects.toThrow(/más de una invitación/);
    expect((await revoke(json("POST", "/x"), ctx({ id: b.invitationId }))).status).toBe(204);
    await acceptInvitation({ sub: ANA, email: ANA_EMAIL });
    const ms = await db.membership.findMany({ where: { profileId: ANA } });
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ organizationId: "org_a", role: "ACCOUNTANT", modules: ["IVA"] });
    // Nueva invitación de B mientras está activa en A: no se acepta.
    as(OWNER_B);
    expect((await invite(json("POST", "/api/organization/invitations", inviteBody(ANA_EMAIL)))).status).toBe(201);
    await expect(acceptInvitation({ sub: ANA, email: ANA_EMAIL })).rejects.toThrow(/otro estudio/);
    expect(await db.membership.count({ where: { profileId: ANA } })).toBe(1);
    expect(a.invitationId).not.toBe(b.invitationId);
  });

  it("aceptaciones simultáneas de la misma invitación: una sola membresía", async () => {
    as(OWNER_A);
    await invite(json("POST", "/api/organization/invitations", inviteBody(ANA_EMAIL)));
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => acceptInvitation({ sub: ANA, email: ANA_EMAIL })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.membership.count({ where: { profileId: ANA } })).toBe(1);
  });

  it("cupo concurrente: reactivar e invitar a la vez con una sola plaza libre -> exactamente una", async () => {
    const { ana, bea } = await seedTwoUsers();
    as(OWNER_A);
    for (let round = 0; round < 5; round++) {
      await db.organizationInvitation.deleteMany({ where: { status: "PENDING" } });
      await db.membership.updateMany({ where: { id: { in: [ana, bea] } }, data: { status: "DISABLED" } });
      // Propietario activo + 1 pendiente base = 2 ocupadas; límite 3 => UNA plaza.
      await db.organization.update({ where: { id: "org_a" }, data: { seatLimit: 3 } });
      expect((await invite(json("POST", "/api/organization/invitations", inviteBody(`base${round}@estudio.test`)))).status).toBe(201);
      const results = await Promise.all([
        enableMember(json("POST", "/x"), ctx({ id: ana })),
        enableMember(json("POST", "/x"), ctx({ id: bea })),
        invite(json("POST", "/api/organization/invitations", inviteBody(`c${round}@estudio.test`))),
        invite(json("POST", "/api/organization/invitations", inviteBody(`d${round}@estudio.test`))),
      ]);
      const ok = results.filter((r) => r.status === 200 || r.status === 201);
      expect(ok).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(3);
      const used =
        (await db.membership.count({ where: { organizationId: "org_a", status: "ACTIVE" } })) +
        (await db.organizationInvitation.count({ where: { organizationId: "org_a", status: "PENDING", expiresAt: { gt: new Date() } } }));
      expect(used).toBe(3);
    }
  });

  it("Data API cerrada: anon/authenticated/service_role sin acceso a tablas, secuencias ni funciones de public (también futuras)", async () => {
    const tables = await db.$queryRaw<{ relname: string; rls: boolean; force: boolean; policies: bigint }[]>`
      SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY 1`;
    expect(tables.map((t) => t.relname)).toEqual(expect.arrayContaining(["Client", "Membership", "Profile", "OrganizationInvitation", "MembershipClient", "_prisma_migrations"]));
    for (const t of tables) expect({ t: t.relname, rls: t.rls, force: t.force, policies: Number(t.policies) }).toEqual({ t: t.relname, rls: true, force: false, policies: 0 });

    const exposed = await db.$queryRaw<{ who: string; obj: string }[]>`
      SELECT r.rolname AS who, c.relname AS obj
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) r
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','S')
        AND (CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(r.rolname, c.oid, 'USAGE,SELECT,UPDATE')
             ELSE has_table_privilege(r.rolname, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') END)
      UNION ALL
      SELECT r.rolname, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN (SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) r
      WHERE n.nspname = 'public' AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')`;
    expect(exposed).toEqual([]);

    // Efectivo: como los roles de la API, lectura y escritura fallan por permisos.
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const sql of [`SELECT 1 FROM "Client" LIMIT 1`, `SELECT 1 FROM "Membership" LIMIT 1`, `SELECT 1 FROM "OrganizationInvitation" LIMIT 1`, `UPDATE "Membership" SET "role" = 'OWNER'`]) {
        await expect(
          db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
            await tx.$executeRawUnsafe(sql);
          }),
        ).rejects.toThrow(/permission denied/);
      }
    }

    // Objetos futuros creados por el rol que migra tampoco quedan expuestos.
    await db.$executeRawUnsafe(`CREATE TABLE "_probe_future"(id int)`);
    await db.$executeRawUnsafe(`CREATE SEQUENCE "_probe_future_seq"`);
    await db.$executeRawUnsafe(`CREATE FUNCTION public._probe_future_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
    try {
      const fut = await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role')
          AND (has_table_privilege(r.rolname, '"_probe_future"', 'SELECT,INSERT,UPDATE,DELETE')
               OR has_sequence_privilege(r.rolname, '"_probe_future_seq"', 'USAGE,SELECT,UPDATE')
               OR has_function_privilege(r.rolname, 'public._probe_future_fn()', 'EXECUTE'))`;
      expect(Number(fut[0].n)).toBe(0);
      // Efectivo: anon no lee la tabla futura ni ejecuta la función futura.
      for (const sql of [`SELECT 1 FROM "_probe_future"`, `SELECT public._probe_future_fn()`]) {
        await expect(
          db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL ROLE anon`);
            await tx.$executeRawUnsafe(sql);
          }),
        ).rejects.toThrow(/permission denied/);
      }
    } finally {
      await db.$executeRawUnsafe(`DROP FUNCTION public._probe_future_fn()`);
      await db.$executeRawUnsafe(`DROP TABLE "_probe_future"`);
      await db.$executeRawUnsafe(`DROP SEQUENCE "_probe_future_seq"`);
    }

    // El propietario (Prisma) sigue operando con RLS activo y sin políticas.
    as(OWNER_A);
    expect(await clientNames()).toEqual(["Cliente Dos", "Cliente Tres", "Cliente Uno"]);
  });
});
