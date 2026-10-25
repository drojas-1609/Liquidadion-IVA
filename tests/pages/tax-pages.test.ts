import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const H = vi.hoisted(() => ({
  claims: { throw: null as unknown, value: null as unknown },
  db: { current: null as unknown },
}));
vi.mock("@/lib/auth/claims", () => ({
  getAuthClaims: async () => {
    if (H.claims.throw) throw H.claims.throw;
    return H.claims.value;
  },
}));
vi.mock("@/lib/prisma", () => ({
  get default() {
    return H.db.current;
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOTFOUND_PAGE");
  },
  useRouter: () => ({ push: () => {}, refresh: () => {}, back: () => {} }),
}));

import {
  freshDbMock,
  freshRecorder,
  wireDb,
  makeWorld,
  claimsFor,
  clientRow,
  periodRow,
  taxRecordRow,
  SUB_OWNER_A,
  SUB_ADMIN_A,
  SUB_ACCOUNTANT_A,
  SUB_VIEWER_A,
  SUB_OWNER_B,
  ORG_A,
  ORG_B,
  type World,
  closePeriodInWorld,
} from "../api/_harness";
import { PeriodClosedNotice } from "@/app/(app)/client/[id]/period/[periodId]/_components/period-closed-notice";
import { AccessNotice } from "@/app/_components/access-notice";
import TaxesPage from "@/app/(app)/client/[id]/period/[periodId]/taxes/page";
import NewTaxPage from "@/app/(app)/client/[id]/period/[periodId]/taxes/new/page";
import EditTaxPage from "@/app/(app)/client/[id]/period/[periodId]/taxes/[taxId]/edit/page";
import { TaxForm, type TaxFormProps } from "@/app/(app)/client/[id]/period/[periodId]/taxes/_components/tax-form";
import { TaxRowActions } from "@/app/(app)/client/[id]/period/[periodId]/taxes/_components/tax-row-actions";

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: ReturnType<typeof freshDbMock>;
let world: World;

const T0 = "2026-05-15T10:20:30.123Z";
const ORIGINAL_TZ = process.env.TZ;

beforeEach(() => {
  db = freshDbMock();
  world = makeWorld({
    clients: [clientRow("c_a", ORG_A), clientRow("c_a2", ORG_A), clientRow("c_b", ORG_B)],
    periods: [periodRow("p_a", "c_a", ORG_A), periodRow("p_a_jun", "c_a", ORG_A, { month: 6 }), periodRow("p_b", "c_b", ORG_B)],
    taxRecords: [
      taxRecordRow("t_a", "p_a", ORG_A),
      taxRecordRow("t_legacy", "p_a", ORG_A, { type: "RETENCION GANANCIAS", date: new Date("2026-05-31T00:00:00.000Z"), description: null }),
      taxRecordRow("t_jun", "p_a_jun", ORG_A, { date: new Date("2026-06-01T00:00:00.000Z") }),
      taxRecordRow("t_b", "p_b", ORG_B),
    ],
  });
  wireDb(db, world, freshRecorder());
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const as = (sub: string | null) => (H.claims.value = sub === null ? null : claimsFor(sub));
const noticeOf = (el: any): string | null => (el && el.type === AccessNotice ? el.props.notice : null);
function findAll(node: any, type: unknown, out: any[] = []): any[] {
  if (Array.isArray(node)) for (const n of node) findAll(n, type, out);
  else if (node && typeof node === "object" && "props" in node) {
    if (node.type === type) out.push(node);
    findAll(node.props.children, type, out);
  }
  return out;
}
const html = (el: any) => renderToStaticMarkup(el);
/** Etiqueta <input> con ese name (los atributos se comparan sin depender de su orden). */
const inputTag = (markup: string, name: string): string => {
  const tag = (markup.match(/<input[^>]*>/g) ?? []).find((t) => t.includes(` name="${name}"`));
  if (!tag) throw new Error(`sin <input name="${name}">`);
  return tag;
};
const expectAttrs = (tag: string, attrs: string[]) => {
  for (const a of attrs) expect(tag, a).toContain(a);
};
const ROLES = [
  ["OWNER", SUB_OWNER_A],
  ["ADMIN", SUB_ADMIN_A],
  ["ACCOUNTANT", SUB_ACCOUNTANT_A],
] as const;

// ═════════════════════════════════════════════════════════════════════════
// Listado
// ═════════════════════════════════════════════════════════════════════════

describe("listado de retenciones/percepciones", () => {
  const call = (id = "c_a", periodId = "p_a") => TaxesPage({ params: Promise.resolve({ id, periodId }) });
  const actionsOf = async () => findAll(await call(), TaxRowActions).map((e) => e.props);

  it.each([
    ["OWNER", SUB_OWNER_A, true, true, true],
    ["ADMIN", SUB_ADMIN_A, true, true, true],
    ["ACCOUNTANT", SUB_ACCOUNTANT_A, true, true, false],
    ["VIEWER", SUB_VIEWER_A, false, false, false],
  ])("%s (%s): Nueva=%s, Editar=%s, Eliminar=%s", async (_l, sub, canCreate, canEdit, canDelete) => {
    as(sub);
    const markup = html(await call());
    expect(markup.includes("Nueva Retención/Percepción")).toBe(canCreate);
    expect(markup.includes("<th>Acciones</th>")).toBe(canEdit || canDelete);
    const actions = await actionsOf();
    if (!canEdit && !canDelete) {
      expect(actions).toHaveLength(0);
      expect(markup).not.toMatch(/Editar|Eliminar/);
      return;
    }
    expect(actions).toHaveLength(2);
    for (const a of actions) {
      expect(a.canDelete).toBe(canDelete);
      expect(a.editHref === null).toBe(!canEdit);
    }
  });

  it("acciones: sólo id, token, etiqueta (tipo y fecha) y permisos; key con el token", async () => {
    const el = await call();
    const actions = findAll(el, TaxRowActions);
    const byId = Object.fromEntries(actions.map((a) => [a.props.taxId, a]));
    expect(byId.t_a.props).toEqual({
      taxId: "t_a",
      updatedAt: T0,
      label: "Retención IVA del 10/05/2026",
      editHref: "/client/c_a/period/p_a/taxes/t_a/edit",
      canDelete: true,
    });
    expect(byId.t_a.key).toBe(`t_a-${T0}`);
    expect(byId.t_legacy.props.label).toBe("Tipo no reconocido (RETENCION GANANCIAS) del 31/05/2026");
    expect(JSON.stringify(actions.map((a) => a.props))).not.toMatch(/2500|Galicia|organizationId/);
  });

  it("tipos: rótulo del catálogo; desconocido marcado con su valor original", async () => {
    const markup = html(await call());
    expect(markup).toContain("Retención IVA");
    expect(markup).not.toContain(">RETENCION IVA<");
    expect(markup).toContain("<strong>Tipo no reconocido</strong> <span>(RETENCION GANANCIAS)</span>");
  });

  it("tipo desconocido con HTML: React lo escapa", async () => {
    world.taxRecords![1].type = '<img src=x onerror="alert(1)">';
    const markup = html(await call());
    expect(markup).not.toContain("<img src=x");
    expect(markup).toContain("(&lt;img src=x onerror=&quot;alert(1)&quot;&gt;)");
  });

  it.each(["UTC", "America/Argentina/Buenos_Aires", "Pacific/Pago_Pago", "Pacific/Kiritimati"])(
    "fechas dd/mm/aaaa por día UTC, sin depender de la zona horaria (TZ=%s)",
    async (tz) => {
      process.env.TZ = tz;
      const markup = html(await call());
      expect(markup).toContain("<td>10/05/2026</td>");
      expect(markup).toContain("<td>31/05/2026</td>");
      expect(markup).not.toMatch(/30\/05\/2026|01\/06\/2026|09\/05\/2026/);
    },
  );

  it("sólo los registros del período y la organización activa", async () => {
    await call();
    expect(db.taxRecord.findMany).toHaveBeenCalledWith({ where: { periodId: "p_a", organizationId: ORG_A }, orderBy: { date: "desc" } });
    expect(findAll(await call(), TaxRowActions).map((a) => a.props.taxId).sort()).toEqual(["t_a", "t_legacy"]);
  });

  it("lista vacía: fila de aviso que abarca todas las columnas (5 con acciones, 4 sin)", async () => {
    world.taxRecords = [];
    expect(html(await call())).toContain('<td colSpan="5"');
    as(SUB_VIEWER_A);
    expect(html(await call())).toContain('<td colSpan="4"');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Alta
// ═════════════════════════════════════════════════════════════════════════

describe("página de alta (servidor + formulario compartido)", () => {
  const call = (id = "c_a", periodId = "p_a") => NewTaxPage({ params: Promise.resolve({ id, periodId }) });

  it.each(ROLES)("%s -> formulario con props EXACTAS (límites del período, valores iniciales del alta)", async (_l, sub) => {
    as(sub);
    const el: any = await call();
    expect(el.type).toBe(TaxForm);
    expect(el.props).toEqual({
      clientId: "c_a",
      periodId: "p_a",
      periodLabel: "05/2026",
      dateMin: "2026-05-01",
      dateMax: "2026-05-31",
      initial: { date: "", type: "RETENCION IVA", amount: "", description: "" },
    });
  });

  it("límites de un febrero bisiesto", async () => {
    world.periods.push(periodRow("p_feb", "c_a", ORG_A, { month: 2, year: 2024 }));
    const el: any = await call("c_a", "p_feb");
    expect([el.props.dateMin, el.props.dateMax]).toEqual(["2024-02-01", "2024-02-29"]);
  });

  it("VIEWER -> aviso de permisos (contrato de acceso), sin formulario ni lectura del período", async () => {
    as(SUB_VIEWER_A);
    const el = await call();
    expect(noticeOf(el)).toBe("forbidden");
    expect(db.period.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ["período de otra organización", () => call("c_b", "p_b")],
    ["cliente de la URL distinto del cliente del período", () => call("c_a2", "p_a")],
    ["período inexistente", () => call("c_a", "p_missing")],
    ["usuario de otra organización", () => (as(SUB_OWNER_B), call())],
  ])("%s -> 404", async (_l, run) => {
    await expect((run as () => Promise<unknown>)()).rejects.toThrow("NOTFOUND_PAGE");
  });

  it("sin sesión -> redirect('/login')", async () => {
    as(null);
    await expect(call()).rejects.toThrow("REDIRECT:/login");
  });

  it("render: mismos textos funcionales del alta anterior, catálogo, límites de fecha y sin tipo desconocido", async () => {
    const markup = html(await call());
    expect(markup).toContain("Nueva Retención / Percepción");
    for (const label of ["Fecha", "Tipo", "Monto", "Descripción (Opcional)"]) expect(markup).toContain(`>${label}</label>`);
    expectAttrs(inputTag(markup, "date"), ['type="date"', 'required=""', 'min="2026-05-01"', 'max="2026-05-31"', 'value=""']);
    expectAttrs(inputTag(markup, "amount"), ['type="text"', 'inputMode="decimal"', 'required=""', 'placeholder="0.00"', 'value=""']);
    expectAttrs(inputTag(markup, "description"), ['type="text"', 'placeholder="Ej. Banco Galicia"', 'maxLength="200"', 'value=""']);
    expect(inputTag(markup, "description")).not.toContain("required");
    const options = [...markup.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
    expect(options).toEqual([
      ["RETENCION IVA", "Retención IVA"],
      ["PERCEPCION IVA", "Percepción IVA"],
      ["RETENCION IIBB", "Retención IIBB"],
      ["PERCEPCION IIBB", "Percepción IIBB"],
      ["SIRCREB", "SIRCREB (recaudación bancaria IIBB)"],
      ["SIRTAC", "SIRTAC (recaudación tarjetas IIBB)"],
    ]);
    expect(markup).toMatch(/<option value="RETENCION IVA" selected="">/);
    expect(markup).toContain('<button type="submit" class="btn btn-primary">Guardar</button>');
    expect(markup).toContain(">Cancelar</button>");
    expect(markup).not.toContain("Tipo no reconocido");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Edición
// ═════════════════════════════════════════════════════════════════════════

describe("página de edición", () => {
  const call = (taxId = "t_a", id = "c_a", periodId = "p_a") => EditTaxPage({ params: Promise.resolve({ id, periodId, taxId }) });

  it.each(ROLES)("%s -> formulario compartido con props EXACTAS y key = token", async (_l, sub) => {
    as(sub);
    const el: any = await call();
    expect(el.type).toBe(TaxForm);
    expect(el.key).toBe(T0);
    expect(el.props).toEqual({
      clientId: "c_a",
      periodId: "p_a",
      periodLabel: "05/2026",
      dateMin: "2026-05-01",
      dateMax: "2026-05-31",
      initial: { date: "2026-05-10", type: "RETENCION IVA", amount: "2500.00", description: "Banco Galicia" },
      edit: { taxId: "t_a", updatedAt: T0, unknownType: null },
    });
    expect(JSON.stringify(el.props)).not.toMatch(/organizationId|createdById|updatedById|ORG_A|org_a/);
  });

  it("la lectura filtra por registro, período y organización", async () => {
    await call();
    expect(db.taxRecord.findFirst).toHaveBeenCalledWith({ where: { id: "t_a", periodId: "p_a", organizationId: ORG_A } });
  });

  it("VIEWER -> aviso de permisos, sin leer el registro", async () => {
    as(SUB_VIEWER_A);
    expect(noticeOf(await call())).toBe("forbidden");
    expect(db.taxRecord.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ["registro de otro período del mismo cliente", () => call("t_jun")],
    ["registro de otra organización con el mismo id pedido desde ORG_A", () => call("t_b")],
    ["registro inexistente", () => call("t_missing")],
    ["cliente de la URL distinto del cliente del período", () => call("t_a", "c_a2")],
    ["período de otra organización", () => call("t_b", "c_b", "p_b")],
    ["usuario de otra organización", () => (as(SUB_OWNER_B), call())],
  ])("%s -> 404", async (_l, run) => {
    await expect((run as () => Promise<unknown>)()).rejects.toThrow("NOTFOUND_PAGE");
  });

  it("tipo histórico desconocido: selector vacío, opción deshabilitada marcada y guardado bloqueado", async () => {
    const el: any = await call("t_legacy");
    expect(el.props.initial).toEqual({ date: "2026-05-31", type: "", amount: "2500.00", description: "" });
    expect(el.props.edit).toEqual({ taxId: "t_legacy", updatedAt: T0, unknownType: "RETENCION GANANCIAS" });
    const markup = html(el);
    expect(markup).toMatch(/<option value="" disabled="" selected="">Tipo no reconocido: RETENCION GANANCIAS<\/option>/);
    expect(markup).toContain("Tipo no reconocido: «RETENCION GANANCIAS». Elegí un tipo válido de la lista para poder guardar.");
    expect(markup).toMatch(/<button type="submit" class="btn btn-primary" disabled="">Guardar cambios<\/button>/);
  });

  it.each(["UTC", "America/Argentina/Buenos_Aires", "Pacific/Kiritimati"])("fecha inicial por día UTC (TZ=%s): 31/05 sigue siendo 2026-05-31", async (tz) => {
    process.env.TZ = tz;
    const el: any = await call("t_legacy");
    expect(el.props.initial.date).toBe("2026-05-31");
  });

  it("render: título y botón de edición, valores precargados, Cancelar vuelve al listado; sin cambio de período", async () => {
    const markup = html(await call());
    expect(markup).toContain("Editar Retención / Percepción");
    expect(markup).toContain("Período 05/2026");
    expectAttrs(inputTag(markup, "date"), ['min="2026-05-01"', 'max="2026-05-31"', 'value="2026-05-10"']);
    expect(markup).toMatch(/<option value="RETENCION IVA" selected="">Retención IVA<\/option>/);
    expectAttrs(inputTag(markup, "amount"), ['value="2500.00"']);
    expectAttrs(inputTag(markup, "description"), ['value="Banco Galicia"']);
    expect(markup).toContain('<a class="btn btn-secondary" href="/client/c_a/period/p_a/taxes">Cancelar</a>');
    expect(markup).toMatch(/<button type="submit" class="btn btn-primary">Guardar cambios<\/button>/);
    expect(markup).not.toMatch(/name="periodId"|Tipo no reconocido/);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Componentes cliente: render inicial
// ═════════════════════════════════════════════════════════════════════════

describe("formulario compartido — render inicial", () => {
  const base: TaxFormProps = {
    clientId: "c_a",
    periodId: "p_a",
    periodLabel: "05/2026",
    dateMin: "2026-05-01",
    dateMax: "2026-05-31",
    initial: { date: "", type: "RETENCION IVA", amount: "", description: "" },
  };

  it("sin errores ni avisos al abrir; envío habilitado", () => {
    const markup = renderToStaticMarkup(createElement(TaxForm, base));
    expect(markup).not.toMatch(/role="alert"|Recargar|aria-invalid/);
    expect(markup).toContain('<button type="submit" class="btn btn-primary">Guardar</button>');
  });
});

describe("acciones de fila — render inicial", () => {
  const props = { taxId: "t_a", updatedAt: T0, label: "Retención IVA del 10/05/2026", editHref: "/client/c_a/period/p_a/taxes/t_a/edit", canDelete: true };

  it("editar (enlace) y eliminar (botón), sin confirmación abierta", () => {
    const markup = renderToStaticMarkup(createElement(TaxRowActions, props));
    expect(markup).toContain('href="/client/c_a/period/p_a/taxes/t_a/edit"');
    expect(markup).toContain('aria-label="Editar Retención IVA del 10/05/2026"');
    expect(markup).toContain('aria-label="Eliminar Retención IVA del 10/05/2026"');
    expect(markup).not.toMatch(/Confirmar eliminación|¿Eliminar|role="alert"|role="status"/);
  });

  it("sin permiso de baja -> sólo editar; sin ninguna acción -> nada", () => {
    expect(renderToStaticMarkup(createElement(TaxRowActions, { ...props, canDelete: false }))).not.toContain("Eliminar");
    expect(renderToStaticMarkup(createElement(TaxRowActions, { ...props, canDelete: false, editHref: null }))).toBe("");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Fuentes
// ═════════════════════════════════════════════════════════════════════════

describe("fuentes de UI de retenciones/percepciones", () => {
  const read = (p: string) => readFileSync(new URL(`../../app/(app)/client/[id]/period/[periodId]/taxes/${p}`, import.meta.url), "utf8");
  const form = read("_components/tax-form.tsx");
  const actions = read("_components/tax-row-actions.tsx");
  const pages = { list: read("page.tsx"), create: read("new/page.tsx"), edit: read("[taxId]/edit/page.tsx") };
  /** Código sin comentarios (los comentarios describen llamadas sin ejecutarlas). */
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("componentes cliente: 'use client', sin diálogos del navegador, DOM directo ni recarga completa", () => {
    for (const s of [form, actions]) {
      expect(s.startsWith('"use client";')).toBe(true);
      expect(s).not.toMatch(/\b(window\.)?(confirm|alert|prompt)\s*\(/);
      expect(s).not.toMatch(/\bdocument\.|window\.location|location\.(reload|href|assign|replace)|\.remove\(\)|removeChild|innerHTML/);
    }
  });

  it("componentes cliente sin Prisma ni módulos server-only", () => {
    for (const s of [form, actions]) {
      expect(s).not.toMatch(/@prisma\/client|["']server-only["']|@\/lib\/prisma\b|@\/lib\/(api-input|serializers|tax-record-lock|period-lock|auth\/)/);
    }
  });

  it("páginas: Server Components (sin 'use client') con guardPage y el rol que corresponde", () => {
    for (const s of Object.values(pages)) {
      expect(s).not.toMatch(/^"use client"/);
      expect(s).toContain("guardPage(");
    }
    expect(pages.create).toMatch(/requirePeriodAccess\(profileId, periodId, ROLES_CREATE, \{ expectClientId: id \}\)/);
    expect(pages.edit).toMatch(/requirePeriodAccess\(profileId, periodId, ROLES_UPDATE, \{ expectClientId: id \}\)/);
    expect(pages.list).not.toMatch(/toLocaleDateString/);
  });

  it("formulario: un envío a la vez; éxito -> listado y refresh; stale -> Recargar (refresh)", () => {
    expect(form).toMatch(/await runExclusive\(inFlight, async \(\) => \{/);
    expect(form).toMatch(/disabled=\{busy \|\| unknownTypePending\}/);
    expect(form).toMatch(/setPhase\("saved"\);\s*router\.push\(taxListHref\(clientId, periodId\)\);\s*router\.refresh\(\);/);
    expect(form).toMatch(/generalError\.stale && \([\s\S]*?onClick=\{\(\) => router\.refresh\(\)\}[\s\S]*?Recargar/);
    // Token: el PATCH exitoso actualiza el token vigente.
    expect(form).toMatch(/if \(edit\) setToken\(\(current\) => nextTaxUpdateToken\(current, result\)\);/);
  });

  it("baja: confirmación en la página, sin retiro optimista; sólo tras el 204: done -> refresh", () => {
    expect(actions).toMatch(/role="group" aria-labelledby=\{promptId\}/);
    expect(actions).toMatch(/await runExclusive\(inFlight, async \(\) => \{/);
    expect(actions).toMatch(
      /if \(!result\.ok\) \{\s*dispatch\(\{ type: "fail", feedback: result\.feedback \}\);\s*return;\s*\}\s*(\/\/[^\n]*\n\s*)?dispatch\(\{ type: "done" \}\);\s*router\.refresh\(\);/,
    );
    expect(code(actions).match(/router\.refresh\(\)/g)).toHaveLength(2); // éxito y "Recargar"
    expect(actions).toMatch(/state\.feedback\.stale && \([\s\S]*?Recargar/);
    expect(actions).not.toMatch(/markDeleted|DeletableInvoiceRow|invoice-form-client/);
  });
});

// ── Período cerrado ─────────────────────────────────────────────────────────

function allNodesOf(node: any, out: any[] = []): any[] {
  if (Array.isArray(node)) for (const n of node) allNodesOf(n, out);
  else if (node && typeof node === "object" && "props" in node) {
    out.push(node);
    allNodesOf(node.props?.children, out);
  }
  return out;
}

describe("retenciones/percepciones — período cerrado", () => {
  const list = () => TaxesPage({ params: Promise.resolve({ id: "c_a", periodId: "p_a" }) });
  const create = () => NewTaxPage({ params: Promise.resolve({ id: "c_a", periodId: "p_a" }) });
  const edit = (taxId = "t_a") => EditTaxPage({ params: Promise.resolve({ id: "c_a", periodId: "p_a", taxId }) });
  const hrefs = (el: any) => allNodesOf(el).map((n) => n.props?.href).filter((h) => typeof h === "string");

  it("lista abierta (referencia): alta y acciones visibles para OWNER", async () => {
    const el = await list();
    expect(hrefs(el)).toContain("/client/c_a/period/p_a/taxes/new");
    expect(findAll(el, TaxRowActions).length).toBeGreaterThan(0);
  });

  it.each([
    ["OWNER", SUB_OWNER_A],
    ["ADMIN", SUB_ADMIN_A],
    ["ACCOUNTANT", SUB_ACCOUNTANT_A],
  ])("lista cerrada (%s): sin alta ni acciones; los registros se siguen viendo", async (_r, sub) => {
    as(sub);
    closePeriodInWorld(world, "p_a");
    const el = await list();
    expect(hrefs(el)).not.toContain("/client/c_a/period/p_a/taxes/new");
    expect(findAll(el, TaxRowActions)).toHaveLength(0);
    expect(allNodesOf(el).filter((n) => n.type === "tr").length).toBeGreaterThan(1);
  });

  it("alta en período cerrado -> aviso, sin formulario", async () => {
    closePeriodInWorld(world, "p_a");
    const el: any = await create();
    expect(el.type).toBe(PeriodClosedNotice);
    expect(findAll(el, TaxForm)).toHaveLength(0);
  });

  it("edición en período cerrado -> aviso, sin formulario; registro inexistente -> notFound()", async () => {
    closePeriodInWorld(world, "p_a");
    const el: any = await edit();
    expect(el.type).toBe(PeriodClosedNotice);
    await expect(edit("t_missing")).rejects.toThrow("NOTFOUND_PAGE");
  });

  it("VIEWER en período cerrado -> aviso de permisos en alta y edición", async () => {
    as(SUB_VIEWER_A);
    closePeriodInWorld(world, "p_a");
    expect(noticeOf(await create())).toBe("forbidden");
    expect(noticeOf(await edit())).toBe("forbidden");
  });
});
