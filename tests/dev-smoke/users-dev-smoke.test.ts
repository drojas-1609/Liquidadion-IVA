import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID, randomBytes } from "node:crypto";
import { devUrl } from "../../scripts/arca/homologation-runner";

/**
 * PRUEBA DEV de Usuarios del estudio con DOS USUARIAS SINTÉTICAS y el caso de
 * CUPO CONCURRENTE, contra la base DEV (esyfpakajthdifhnhcew) DESPUÉS de aplicar
 * 20261104120000_studio_users_permissions y de su postcheck.
 *
 * NO corre por defecto. Sólo con:
 *   USERS_DEV_SMOKE=yes-esyfpakajthdifhnhcew
 *   USERS_DEV_SMOKE_URL=<URL DEV aceptada por devUrl(): directa o pooler sesión :5432>
 * Lo lanza ~/studio-users-dev-kit/90-synthetic-smoke.sh (URL en prompt oculto,
 * sólo en el entorno del proceso hijo).
 *
 * Garantías:
 *  - Trabaja SÓLO en un estudio sintético nuevo (`syn_users_<run>`), con clientes,
 *    períodos y Profiles sintéticos (dominio .invalid). Nunca TRUNCATE ni
 *    escrituras fuera de ese estudio; lo verifica comparando antes/después un
 *    hash de todo lo que NO es sintético.
 *  - No crea cuentas en Supabase Auth ni envía correos (mailer simulado).
 *  - Deja los datos sintéticos: se limpian con 99-cleanup-synthetic.sql, aparte
 *    y con autorización.
 */

const ENABLE = process.env.USERS_DEV_SMOKE === "yes-esyfpakajthdifhnhcew";
const RAW = process.env.USERS_DEV_SMOKE_URL ?? "";
if (ENABLE && !devUrl(RAW)) throw new Error("USERS_DEV_SMOKE_URL no es una URL DEV admitida");
// Ensayo local (scripts/pg-local-regression.sh): sólo 127.0.0.1, nunca Supabase.
const REHEARSAL = (() => {
  const raw = process.env.USERS_DEV_SMOKE_REHEARSAL_URL ?? "";
  if (!raw || ENABLE) return null;
  const u = new URL(raw);
  if (u.hostname !== "127.0.0.1" || /supabase|pooler|bqqruaikbqculvmtirvy|esyfpakajthdifhnhcew/i.test(raw)) {
    throw new Error("USERS_DEV_SMOKE_REHEARSAL_URL debe ser 127.0.0.1");
  }
  return raw;
})();
const URL_DEV = ENABLE ? RAW : REHEARSAL;

const RUN = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}_${randomBytes(3).toString("hex")}`;
const ORG = `syn_users_${RUN}`;
const OWNER = randomUUID();
const ANA = randomUUID(); // Contable, sólo cliente 1, sólo IVA
const BEA = randomUUID(); // Consulta, todos los clientes, Clientes + IVA
const mail = (who: string) => `${who}.${RUN}@sintetico.invalid`;
const C1 = `${ORG}_c1`, C2 = `${ORG}_c2`, P1 = `${ORG}_p1`, P2 = `${ORG}_p2`;

const H = vi.hoisted(() => ({ db: { current: null as unknown }, claims: { value: null as unknown }, authIds: new Map<string, string>(), sent: 0 }));
vi.mock("@/lib/prisma", () => ({
  get default() {
    return H.db.current;
  },
}));
vi.mock("@/lib/auth/claims", () => ({ getAuthClaims: async () => H.claims.value }));
vi.mock("@/lib/users/invitation-mailer", () => ({
  sendInvitationEmail: async (email: string) => {
    H.sent++;
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

import { GET as listClients } from "@/app/api/clients/route";
import { GET as exportLiquidation } from "@/app/api/client/[id]/period/[periodId]/export/route";
import { POST as invite } from "@/app/api/organization/invitations/route";
import { POST as revoke } from "@/app/api/organization/invitations/[id]/revoke/route";
import { PATCH as patchMember } from "@/app/api/organization/members/[id]/route";
import { POST as disableMember } from "@/app/api/organization/members/[id]/disable/route";
import { POST as enableMember } from "@/app/api/organization/members/[id]/enable/route";
import { acceptInvitation } from "@/lib/users/service";
import ClientDashboard from "@/app/(app)/client/[id]/dashboard/page";
import PeriodPage from "@/app/(app)/client/[id]/period/[periodId]/page";
import { renderToStaticMarkup } from "react-dom/server";

const as = (sub: string, email = mail("owner")) => {
  H.claims.value = { sub, email, authRole: "authenticated", raw: {} };
};
const req = (method: string, url: string, body?: unknown) =>
  new Request(`https://dev.invalid${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  });
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

/** Hash de todo lo que NO pertenece al estudio sintético (debe quedar idéntico). */
async function foreignDigest(db: PrismaClient): Promise<string> {
  const rows = await db.$queryRaw<{ d: string }[]>`
    SELECT md5(concat_ws('#',
      (SELECT string_agg((to_jsonb(o) - 'updatedAt')::text, '|' ORDER BY o.id) FROM "Organization" o WHERE o.id NOT LIKE 'syn\_users\_%'),
      (SELECT string_agg(to_jsonb(m)::text, '|' ORDER BY m.id) FROM "Membership" m WHERE m."organizationId" NOT LIKE 'syn\_users\_%'),
      (SELECT string_agg(to_jsonb(c)::text, '|' ORDER BY c.id) FROM "Client" c WHERE c."organizationId" NOT LIKE 'syn\_users\_%'),
      (SELECT string_agg(to_jsonb(p)::text, '|' ORDER BY p.id) FROM "Period" p WHERE p."organizationId" NOT LIKE 'syn\_users\_%'),
      (SELECT count(*)::text FROM "AuditLog" a WHERE a."organizationId" NOT LIKE 'syn\_users\_%'),
      (SELECT count(*)::text FROM "OrganizationInvitation" i WHERE i."organizationId" NOT LIKE 'syn\_users\_%'),
      (SELECT string_agg(to_jsonb(f)::text, '|' ORDER BY f.id) FROM "Profile" f WHERE f.email NOT LIKE '%@sintetico.invalid')
    )) AS d`;
  return rows[0].d;
}

// Con la latencia real a DEV (~150 ms de ida y vuelta) la primera prueba tarda ~30 s: el plazo
// por defecto de vitest (5 s) la cortaba y, como vitest no cancela la promesa vencida, la prueba
// siguiente corría en paralelo con ella (smoke DEV 04/11/2026, runs/20261104T135910Z-smoke).
const DEV_TIMEOUT_MS = 180_000;

describe.skipIf(!URL_DEV)("DEV: usuarios del estudio con dos usuarias sintéticas y cupo concurrente", { timeout: DEV_TIMEOUT_MS }, () => {
  let db: PrismaClient;
  let before = "";
  const report: Record<string, unknown> = { org: ORG };

  beforeAll(async () => {
    db = new PrismaClient({ datasourceUrl: URL_DEV! });
    H.db.current = db;
    const [{ n }] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "_prisma_migrations" WHERE migration_name = '20261104120000_studio_users_permissions' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    expect(Number(n)).toBe(1);
    before = await foreignDigest(db);
    H.authIds = new Map([[mail("ana"), ANA], [mail("bea"), BEA]]);
    await db.organization.create({ data: { id: ORG, name: `Estudio sintético ${RUN}` } });
    await db.profile.create({ data: { id: OWNER, email: mail("owner") } });
    await db.membership.create({ data: { profileId: OWNER, organizationId: ORG, role: "OWNER" } });
    await db.client.createMany({
      data: [
        { id: C1, organizationId: ORG, name: "Sintético Uno", cuit: "30-11111111-4", condition: "Responsable Inscripto" },
        { id: C2, organizationId: ORG, name: "Sintético Dos", cuit: "30-22222222-8", condition: "Responsable Inscripto" },
      ],
    });
    await db.period.createMany({
      data: [
        { id: P1, clientId: C1, organizationId: ORG, month: 1, year: 2026 },
        { id: P2, clientId: C2, organizationId: ORG, month: 1, year: 2026 },
      ],
    });
  }, DEV_TIMEOUT_MS);

  afterAll(async () => {
    if (db) {
      report.foreign_unchanged = (await foreignDigest(db)) === before;
      report.mails_simulated = H.sent;
      console.info(`[users-dev-smoke] ${JSON.stringify(report)}`);
      await db.$disconnect();
    }
  }, DEV_TIMEOUT_MS);

  const names = async () => {
    const r = await listClients(req("GET", "/api/clients"));
    return r.status === 200 ? ((await r.json()) as { name: string }[]).map((c) => c.name).sort() : r.status;
  };
  const exp = async (c: string, p: string) => (await exportLiquidation(req("GET", "/x"), ctx({ id: c, periodId: p }))).status;

  it("dos usuarias de distinto alcance: invitación, aceptación, listados, URL ajena y revocación con sesión abierta", async () => {
    const t0 = Date.now();
    as(OWNER);
    const a = await invite(req("POST", "/api/organization/invitations", { email: mail("ana"), role: "ACCOUNTANT", clientScope: "SELECTED", clientIds: [C1], modules: ["IVA"] }));
    const b = await invite(req("POST", "/api/organization/invitations", { email: mail("bea"), role: "VIEWER", clientScope: "ALL", modules: ["CLIENTS", "IVA"] }));
    expect([a.status, b.status]).toEqual([201, 201]);
    await acceptInvitation({ sub: ANA, email: mail("ana") });
    await acceptInvitation({ sub: BEA, email: mail("bea") });
    const anaM = await db.membership.findFirstOrThrow({ where: { profileId: ANA, organizationId: ORG } });

    as(ANA, mail("ana"));
    expect(await names()).toEqual(["Sintético Uno"]);
    // Cliente asignado, con módulo IVA: historial de períodos, período y exportación.
    const dash = renderToStaticMarkup((await ClientDashboard({ params: Promise.resolve({ id: C1 }) })) as React.ReactElement);
    expect(dash).toContain("Sintético Uno");
    expect(dash).toContain("Períodos fiscales");
    expect(dash).toContain(`/client/${C1}/period/${P1}`);
    const period = renderToStaticMarkup((await PeriodPage({ params: Promise.resolve({ id: C1, periodId: P1 }) })) as React.ReactElement);
    expect(period).toContain("Período 01/2026");
    expect(period).toContain(`/client/${C1}/period/${P1}/liquidation`);
    expect(await exp(C1, P1)).toBe(200);
    // Fuera de su alcance: 404 idéntico a inexistente (tablero, período y exportación).
    expect(await exp(C2, P2)).toBe(404);
    expect(await exp(C1, P2)).toBe(404);
    await expect(ClientDashboard({ params: Promise.resolve({ id: C2 }) })).rejects.toThrow("NOTFOUND_PAGE");
    await expect(PeriodPage({ params: Promise.resolve({ id: C2, periodId: P2 }) })).rejects.toThrow("NOTFOUND_PAGE");
    // Importar (PR #25) queda para la prueba de integración entre ambos PR (docs/usuarios/DEV-PILOTO.md §5).

    as(BEA, mail("bea"));
    expect(await names()).toEqual(["Sintético Dos", "Sintético Uno"]);
    expect(await exp(C2, P2)).not.toBe(404);

    // Revocación con la sesión de Ana "abierta" (mismos claims).
    as(OWNER);
    expect((await patchMember(req("PATCH", "/x", { role: "ACCOUNTANT", clientScope: "SELECTED", clientIds: [C2], modules: ["IVA"] }), ctx({ id: anaM.id }))).status).toBe(200);
    as(ANA, mail("ana"));
    expect(await names()).toEqual(["Sintético Dos"]);
    expect(await exp(C1, P1)).toBe(404);
    as(OWNER);
    expect((await disableMember(req("POST", "/x"), ctx({ id: anaM.id }))).status).toBe(200);
    as(ANA, mail("ana"));
    expect(await names()).toBe(403);
    report.two_users = "OK";
    report.two_users_ms = Date.now() - t0;
  });

  it("cupo concurrente: con una plaza libre, de cuatro altas simultáneas entra exactamente una (5 rondas)", async () => {
    const t0 = Date.now();
    // Independiente de la prueba anterior: dos accesos propios, sintéticos y desactivados.
    const CAR = randomUUID(), DAN = randomUUID();
    await db.profile.createMany({ data: [{ id: CAR, email: mail("car") }, { id: DAN, email: mail("dan") }] });
    await db.membership.createMany({
      data: [CAR, DAN].map((profileId) => ({ profileId, organizationId: ORG, role: "VIEWER" as const, modules: ["IVA" as const], status: "DISABLED" as const })),
    });
    const ms = await db.membership.findMany({ where: { organizationId: ORG, profileId: { in: [CAR, DAN] } }, select: { id: true } });
    expect(ms).toHaveLength(2);
    as(OWNER);
    const outcomes: number[][] = [];
    const conflicts: Record<string, number> = {};
    for (let round = 0; round < 5; round++) {
      const pend = await db.organizationInvitation.findMany({ where: { organizationId: ORG, status: "PENDING" }, select: { id: true } });
      for (const p of pend) expect((await revoke(req("POST", "/x"), ctx({ id: p.id }))).status).toBe(204);
      for (const m of ms) {
        const cur = await db.membership.findUniqueOrThrow({ where: { id: m.id } });
        if (cur.status === "ACTIVE") expect((await disableMember(req("POST", "/x"), ctx({ id: m.id }))).status).toBe(200);
      }
      // Activas + 1 invitación base + 1 plaza libre.
      const active = await db.membership.count({ where: { organizationId: ORG, status: "ACTIVE" } });
      const limit = active + 2;
      await db.organization.update({ where: { id: ORG }, data: { seatLimit: limit } });
      expect((await invite(req("POST", "/api/organization/invitations", { email: mail(`base${round}`), role: "VIEWER", clientScope: "ALL", modules: ["IVA"] }))).status).toBe(201);
      const rs = await Promise.all([
        enableMember(req("POST", "/x"), ctx({ id: ms[0].id })),
        enableMember(req("POST", "/x"), ctx({ id: ms[1].id })),
        invite(req("POST", "/api/organization/invitations", { email: mail(`x${round}`), role: "VIEWER", clientScope: "ALL", modules: ["IVA"] })),
        invite(req("POST", "/api/organization/invitations", { email: mail(`y${round}`), role: "VIEWER", clientScope: "ALL", modules: ["IVA"] })),
      ]);
      const st = rs.map((r) => r.status);
      outcomes.push(st);
      report.concurrent_rounds = outcomes;
      for (const r of rs) {
        const body = (await r.clone().json().catch(() => null)) as { field?: string; error?: { code?: string } } | null;
        if (r.status === 409) {
          const k = body?.field ?? "otro";
          conflicts[k] = (conflicts[k] ?? 0) + 1;
        } else if (r.status !== 200 && r.status !== 201) {
          (report.concurrent_unexpected ??= [] as unknown[]) as unknown[];
          (report.concurrent_unexpected as unknown[]).push({ round, status: r.status, code: body?.error?.code ?? null });
        }
      }
      report.concurrent_conflicts = conflicts;
      expect(st.filter((x) => x >= 500)).toEqual([]);
      expect(st.filter((x) => x === 200 || x === 201)).toHaveLength(1);
      expect(st.filter((x) => x === 409)).toHaveLength(3);
      const used =
        (await db.membership.count({ where: { organizationId: ORG, status: "ACTIVE" } })) +
        (await db.organizationInvitation.count({ where: { organizationId: ORG, status: "PENDING", expiresAt: { gt: new Date() } } }));
      expect(used).toBe(limit);
    }
    // 409 válidos: "seats" (sin plazas) o "busy" (el estudio estaba bloqueado > 3 s).
    expect(Object.keys(conflicts).every((k) => k === "seats" || k === "busy")).toBe(true);
    report.concurrent_ms = Date.now() - t0;
  });

  it("protección del propietario en la base y Data API cerrada (catálogo, sólo lectura)", async () => {
    await expect(db.membership.updateMany({ where: { profileId: OWNER, organizationId: ORG }, data: { status: "DISABLED" } })).rejects.toThrow();
    const exposed = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) r
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
        AND has_table_privilege(r.rolname, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`;
    expect(Number(exposed[0].n)).toBe(0);
    expect(await foreignDigest(db)).toBe(before);
    report.owner_and_data_api = "OK";
  });
});
