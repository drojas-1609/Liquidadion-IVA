import { describe, it, expect, vi, beforeEach } from "vitest";
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
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import {
  freshDbMock,
  freshRecorder,
  wireDb,
  makeWorld,
  claimsFor,
  clientRow,
  periodRow,
  SUB_OWNER_A,
  SUB_ADMIN_A,
  SUB_ACCOUNTANT_A,
  SUB_VIEWER_A,
  SUB_OWNER_B,
  ORG_A,
  ORG_B,
  type World,
} from "../api/_harness";
import EditSalePage from "@/app/(app)/client/[id]/period/[periodId]/sales/[invoiceId]/edit/page";
import EditPurchasePage from "@/app/(app)/client/[id]/period/[periodId]/purchases/[invoiceId]/edit/page";
import SalesPage from "@/app/(app)/client/[id]/period/[periodId]/sales/page";
import PurchasesPage from "@/app/(app)/client/[id]/period/[periodId]/purchases/page";
import {
  InvoiceEditUnavailable,
  InvoiceForm,
  type InvoiceFormProps,
} from "@/app/(app)/client/[id]/period/[periodId]/_components/invoice-form";
import { InvoiceRowActions } from "@/app/(app)/client/[id]/period/[periodId]/_components/invoice-row-actions";
import {
  DeletableInvoiceRow,
  DeletableInvoiceRows,
  InvoiceRowDeletionContext,
  withDeletedRow,
} from "@/app/(app)/client/[id]/period/[periodId]/_components/invoice-deletable-row";
import { AccessNotice } from "@/app/_components/access-notice";
import { buildInvoiceInputV2 } from "@/lib/api-input";
import { resolveManualInvoice } from "@/lib/manual-invoice";
import { clientConditionCode } from "@/lib/client-condition";
import { manualInvoiceColumns, manualInvoiceVatLines } from "@/lib/invoice-write";
import { INVOICE_NOT_EDITABLE_MESSAGES } from "@/lib/invoice-edit";
import { EDIT_PENDING_CONDITION_MESSAGE, EDIT_PENDING_VARIANT_MESSAGE } from "@/lib/invoice-form-client";

/* eslint-disable @typescript-eslint/no-explicit-any */

const T0 = "2026-05-11T10:00:00.000Z";
let db: ReturnType<typeof freshDbMock>;
let world: World;

const RI = { name: "Contraparte SA", docType: 80, docNumber: "30-99999999-5", vatConditionCode: 1 };
const body = (category: "SALES" | "PURCHASES") => ({
  contractVersion: 2,
  category,
  periodId: "p_a",
  date: "2026-05-10",
  voucherCode: 1,
  voucherVariant: "NONE",
  pointOfSale: 1,
  number: 1001,
  counterparty: RI,
  turivaRelationCode: null,
  netAmount: "1000",
  vatRate: "21",
});

/** Fila MANUAL como la escribe el alta, más sus líneas. */
function stored(id: string, category: "SALES" | "PURCHASES", over: Record<string, unknown> = {}) {
  const parsed = buildInvoiceInputV2(body(category));
  if (!parsed.ok) throw new Error(parsed.error);
  const resolved = resolveManualInvoice(parsed.data, clientConditionCode("Responsable Inscripto"));
  if (!resolved.ok) throw new Error(resolved.error);
  const cols = manualInvoiceColumns({ input: parsed.data, resolved: resolved.data, periodId: "p_a", organizationId: ORG_A, clientId: "c_a" });
  const row = { id, ...cols, createdById: SUB_OWNER_A, updatedById: SUB_OWNER_A, createdAt: new Date(T0), updatedAt: new Date(T0), ...over };
  const lines = manualInvoiceVatLines(resolved.data.model).map((l, n) => ({ id: `${id}_vl${n}`, invoiceId: id, organizationId: row.organizationId, ...l }));
  return { row, lines };
}

const setWorld = (rows: Array<ReturnType<typeof stored>> = [stored("inv_s", "SALES"), stored("inv_p", "PURCHASES")]) => {
  world = makeWorld({
    clients: [clientRow("c_a", ORG_A, { name: "Alfa SA" }), clientRow("c_other", ORG_A), clientRow("c_b", ORG_B)],
    periods: [periodRow("p_a", "c_a", ORG_A), periodRow("p_a2", "c_a", ORG_A, { month: 6 }), periodRow("p_b", "c_b", ORG_B)],
    invoices: rows.map((r) => r.row),
    invoiceVatLines: rows.flatMap((r) => r.lines),
  });
  wireDb(db, world, freshRecorder());
  // Listas: filtra como Prisma y adjunta sólo los códigos de alícuota (include de la página).
  db.invoice.findMany.mockImplementation(async ({ where }: any) =>
    (world.invoices ?? [])
      .filter((i) => i.periodId === where.periodId && i.organizationId === where.organizationId && i.category === where.category)
      .map((i) => ({
        ...i,
        vatLines: (world.invoiceVatLines ?? []).filter((l) => l.invoiceId === i.id).map((l) => ({ vatRateCode: l.vatRateCode })),
      })),
  );
};

beforeEach(() => {
  db = freshDbMock();
  setWorld();
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

const as = (sub: string | null) => (H.claims.value = sub === null ? null : claimsFor(sub));
const noticeOf = (el: any): string | null => (el && el.type === AccessNotice ? el.props.notice : null);
/** Recorre un árbol de elementos (sin renderizar) y junta los del tipo pedido. */
function findAll(node: any, type: unknown, out: any[] = []): any[] {
  if (Array.isArray(node)) for (const n of node) findAll(n, type, out);
  else if (node && typeof node === "object" && "props" in node) {
    if (node.type === type) out.push(node);
    findAll(node.props.children, type, out);
  }
  return out;
}
const textOf = (node: any): string =>
  Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" && "props" in node ? textOf(node.props.children) : node == null || node === false ? "" : String(node);

const EXPECTED_INITIAL = {
  selection: { date: "2026-05-10", counterpartyCondition: 1, voucherCode: 1, voucherVariant: "NONE", docType: 80, turivaRelationCode: null, vatRate: "21" },
  fields: { counterpartyName: "Contraparte SA", docNumber: "30999999995", pointOfSale: "1", number: "1001", netAmount: "1000.00" },
};

const EDIT_PAGES = [
  ["ventas", EditSalePage, "SALES", "inv_s", "inv_p"],
  ["compras", EditPurchasePage, "PURCHASES", "inv_p", "inv_s"],
] as const;

describe.each(EDIT_PAGES)("página de edición (%s)", (_name, Page, direction, ownId, otherCategoryId) => {
  const call = (invoiceId: string = ownId, id = "c_a", periodId = "p_a") => Page({ params: Promise.resolve({ id, periodId, invoiceId }) });

  it.each([
    ["OWNER", SUB_OWNER_A],
    ["ADMIN", SUB_ADMIN_A],
    ["ACCOUNTANT", SUB_ACCOUNTANT_A],
  ])("%s -> formulario compartido con props EXACTAS (sin organización, rol, autoría ni source)", async (_role, sub) => {
    as(sub);
    const el: any = await call();
    expect(noticeOf(el)).toBeNull();
    expect(el.type).toBe(InvoiceForm);
    expect(el.key).toBe(T0);
    expect(el.props).toEqual({
      direction,
      clientId: "c_a",
      periodId: "p_a",
      clientName: "Alfa SA",
      period: { month: 5, year: 2026 },
      clientConditionCode: 1,
      turivaIncluded: false,
      edit: {
        invoiceId: ownId,
        updatedAt: T0,
        initial: EXPECTED_INITIAL,
        requiresCounterpartyCondition: false,
        requiresVoucherVariant: false,
      },
    });
    expect(JSON.stringify(el.props)).not.toMatch(/organizationId|createdById|updatedById|"source"|MANUAL|totalVat|lidSection/);
  });

  it("VIEWER -> aviso de permisos, sin formulario ni lectura del comprobante", async () => {
    as(SUB_VIEWER_A);
    expect(noticeOf(await call())).toBe("forbidden");
    expect(db.invoice.findFirst).not.toHaveBeenCalled();
  });

  it("sin sesión -> redirect('/login')", async () => {
    as(null);
    await expect(call()).rejects.toThrow("REDIRECT:/login");
  });

  it("organización ajena -> 404", async () => {
    as(SUB_OWNER_B);
    await expect(call()).rejects.toThrow("NOTFOUND_PAGE");
  });

  it("cliente de la URL distinto del cliente del período -> 404", async () => {
    await expect(call(ownId, "c_other", "p_a")).rejects.toThrow("NOTFOUND_PAGE");
  });

  it("período distinto (del mismo cliente) -> 404", async () => {
    await expect(call(ownId, "c_a", "p_a2")).rejects.toThrow("NOTFOUND_PAGE");
  });

  it("categoría incorrecta (comprobante de la otra lista) -> 404", async () => {
    await expect(call(otherCategoryId)).rejects.toThrow("NOTFOUND_PAGE");
  });

  it("comprobante inexistente -> 404", async () => {
    await expect(call("inv_zzz")).rejects.toThrow("NOTFOUND_PAGE");
  });

  it("comprobante de otra organización con el mismo id pedido desde ORG_A -> 404", async () => {
    setWorld([stored(ownId, direction, { organizationId: ORG_B, periodId: "p_b", clientId: "c_b" })]);
    await expect(call()).rejects.toThrow("NOTFOUND_PAGE");
  });

  it("comprobante del período con OTRO cliente propio -> 404", async () => {
    setWorld([stored(ownId, direction, { clientId: "c_other" })]);
    await expect(call()).rejects.toThrow("NOTFOUND_PAGE");
  });

  it("la lectura filtra por comprobante, organización, período y categoría", async () => {
    await call();
    expect(db.invoice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ownId, organizationId: ORG_A, periodId: "p_a", category: direction } }),
    );
  });

  it.each([
    ["importado", { source: "IMPORT" }, "IMPORTED"],
    ["heredado sin cliente propio", { source: null, clientId: null }, "LEGACY"],
    ["datos insuficientes", { counterpartyName: null }, "INSUFFICIENT_DATA"],
  ] as const)("fila propia no editable (%s) -> aviso estable, sin formulario", async (_l, over, reason) => {
    setWorld([stored(ownId, direction, over)]);
    const el: any = await call();
    expect(el.type).toBe(InvoiceEditUnavailable);
    expect(el.props).toEqual({
      direction,
      clientId: "c_a",
      periodId: "p_a",
      clientName: "Alfa SA",
      period: { month: 5, year: 2026 },
      message: INVOICE_NOT_EDITABLE_MESSAGES[reason],
    });
  });

  it("varias alícuotas -> aviso MULTI_RATE", async () => {
    const s = stored(ownId, direction);
    setWorld([{ row: s.row, lines: [...s.lines, { ...s.lines[0], id: "vl_x", vatRateCode: 4 }] }]);
    const el: any = await call();
    expect(el.type).toBe(InvoiceEditUnavailable);
    expect(el.props.message).toBe(INVOICE_NOT_EDITABLE_MESSAGES.MULTI_RATE);
  });

  it("excepción antigua: condición nula -> editable, selector vacío y bandera", async () => {
    setWorld([stored(ownId, direction, { counterpartyVatConditionCode: null })]);
    const el: any = await call();
    expect(el.type).toBe(InvoiceForm);
    expect(el.props.edit.requiresCounterpartyCondition).toBe(true);
    expect(el.props.edit.initial.selection.counterpartyCondition).toBeNull();
    expect(el.props.edit.initial.selection.voucherCode).toBe(1);
  });

  it("excepción antigua: variante nula en 001 -> editable, variante vacía y bandera", async () => {
    setWorld([stored(ownId, direction, { voucherVariant: null })]);
    const el: any = await call();
    expect(el.props.edit.requiresVoucherVariant).toBe(true);
    expect(el.props.edit.initial.selection.voucherVariant).toBeNull();
  });
});

describe("formulario compartido en modo edición — render inicial", () => {
  const props = (edit: Partial<NonNullable<InvoiceFormProps["edit"]>> = {}, direction: "SALES" | "PURCHASES" = "SALES"): InvoiceFormProps => ({
    direction,
    clientId: "c_a",
    periodId: "p_a",
    clientName: "Alfa SA",
    period: { month: 5, year: 2026 },
    clientConditionCode: 1,
    turivaIncluded: false,
    edit: {
      invoiceId: "inv_s",
      updatedAt: T0,
      initial: EXPECTED_INITIAL as any,
      requiresCounterpartyCondition: false,
      requiresVoucherVariant: false,
      ...edit,
    },
  });
  const html = (p: InvoiceFormProps) => renderToStaticMarkup(createElement(InvoiceForm, p));
  const selected = (h: string, id: string) =>
    h.match(new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`))?.[1].match(/<option[^>]*selected=""[^>]*value="([^"]*)"|<option value="([^"]*)" selected=""/)?.slice(1).find(Boolean) ?? "";

  it("título y botón de edición; valores guardados precargados; guardado habilitado", () => {
    const h = html(props());
    expect(h).toContain("Editar venta");
    expect(h).toContain("Guardar cambios");
    expect(h).not.toContain("Nueva venta");
    expect(h).toMatch(/id="invoice-date"[^>]*value="2026-05-10"|value="2026-05-10"[^>]*id="invoice-date"/);
    for (const v of ['value="Contraparte SA"', 'value="30999999995"', 'value="1001"', 'value="1000.00"']) expect(h).toContain(v);
    expect(h).toMatch(/<button type="submit" class="btn btn-primary">/);
    expect(h).toContain('href="/client/c_a/period/p_a/sales"');
    expect(html(props({}, "PURCHASES"))).toContain("Editar compra");
  });

  it("condición nula: selector vacío, aviso explícito y envío bloqueado", () => {
    const initial = { ...EXPECTED_INITIAL, selection: { ...EXPECTED_INITIAL.selection, counterpartyCondition: null } };
    const h = html(props({ initial: initial as any, requiresCounterpartyCondition: true }));
    expect(selected(h, "invoice-counterparty-condition")).toBe("");
    expect(h).toMatch(new RegExp(`role="alert"[^>]*>${EDIT_PENDING_CONDITION_MESSAGE}`));
    expect(h).toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  // Fixtures de invoice-form-options.test.ts: venta A de 2026 (dos variantes) y compra A de 06/2020 (una).
  it("variante nula con dos variantes (venta A 2026): selector vacío, aviso y envío bloqueado", () => {
    const initial = { ...EXPECTED_INITIAL, selection: { ...EXPECTED_INITIAL.selection, voucherVariant: null } };
    const h = html(props({ initial: initial as any, requiresVoucherVariant: true }));
    expect(h).toContain('value="PAGO_EN_CBU_INFORMADA"');
    expect(selected(h, "invoice-voucher-variant")).toBe("");
    expect(h).toMatch(new RegExp(`role="alert"[^>]*>${EDIT_PENDING_VARIANT_MESSAGE}`));
    expect(h).toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it("variante nula con una sola válida (compra A 06/2020): NONE preseleccionada, sin aviso, guardado habilitado", () => {
    const initial = { ...EXPECTED_INITIAL, selection: { ...EXPECTED_INITIAL.selection, date: "2020-06-10", voucherVariant: null } };
    const h = html(props({ initial: initial as any, requiresVoucherVariant: true }, "PURCHASES"));
    expect(h).not.toContain('value="PAGO_EN_CBU_INFORMADA"');
    expect(selected(h, "invoice-voucher-variant")).toBe("NONE");
    expect(h).not.toContain(EDIT_PENDING_VARIANT_MESSAGE);
    expect(h).toMatch(/<button type="submit" class="btn btn-primary">/);
  });

  it("no muestra importes calculados ni datos de autoría", () => {
    const h = html(props());
    expect(h).not.toMatch(/IVA Calculado|Total \(|createdBy|updatedBy|organizationId|2026-05-11T10/);
  });
});

describe("aviso de edición no disponible", () => {
  it("mensaje estable, vuelta a la lista, sin formulario", () => {
    const h = renderToStaticMarkup(
      createElement(InvoiceEditUnavailable, {
        direction: "PURCHASES",
        clientId: "c_a",
        periodId: "p_a",
        clientName: "Alfa SA",
        period: { month: 5, year: 2026 },
        message: INVOICE_NOT_EDITABLE_MESSAGES.IMPORTED,
      }),
    );
    expect(h).toContain(INVOICE_NOT_EDITABLE_MESSAGES.IMPORTED);
    expect(h).toContain('href="/client/c_a/period/p_a/purchases"');
    expect(h).not.toContain("<form");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Listas: acciones por rol
// ═════════════════════════════════════════════════════════════════════════

const LISTS = [
  ["ventas", SalesPage, "SALES", "sales"],
  ["compras", PurchasesPage, "PURCHASES", "purchases"],
] as const;

describe.each(LISTS)("lista de %s — acciones por rol", (_name, Page, direction, segment) => {
  const call = async () => (await Page({ params: Promise.resolve({ id: "c_a", periodId: "p_a" }) })) as any;
  const rows = () => {
    const pfx = direction === "SALES" ? "s" : "p";
    setWorld([
      stored(`${pfx}_ok`, direction),
      stored(`${pfx}_nodata`, direction, { counterpartyName: null }),
      stored(`${pfx}_imp`, direction, { source: "IMPORT" }),
    ]);
    return pfx;
  };
  const actionsOf = async () => findAll(await call(), InvoiceRowActions).map((e) => e.props);
  const headers = async () => findAll(await call(), "th").map((e) => textOf(e.props.children));

  it("lee sólo los códigos de alícuota, filtrando por período, organización y categoría", async () => {
    rows();
    await call();
    expect(db.invoice.findMany).toHaveBeenCalledWith({
      where: { periodId: "p_a", organizationId: ORG_A, category: direction },
      orderBy: { date: "desc" },
      include: { vatLines: { select: { vatRateCode: true } } },
    });
  });

  it.each([
    ["OWNER", SUB_OWNER_A],
    ["ADMIN", SUB_ADMIN_A],
  ])("%s: editar+eliminar en la editable; sólo eliminar en la no editable; nada en la importada", async (_r, sub) => {
    const pfx = rows();
    as(sub);
    expect(await actionsOf()).toEqual([
      {
        invoiceId: `${pfx}_ok`,
        updatedAt: T0,
        label: "FC A 0001-00001001",
        editHref: `/client/c_a/period/p_a/${segment}/${pfx}_ok/edit`,
        canDelete: true,
      },
      { invoiceId: `${pfx}_nodata`, updatedAt: T0, label: "FC A 0001-00001001", editHref: null, canDelete: true },
    ]);
    expect(await headers()).toContain("Acciones");
  });

  it("ACCOUNTANT: sólo editar la editable; nada en las demás", async () => {
    const pfx = rows();
    as(SUB_ACCOUNTANT_A);
    expect(await actionsOf()).toEqual([
      { invoiceId: `${pfx}_ok`, updatedAt: T0, label: "FC A 0001-00001001", editHref: `/client/c_a/period/p_a/${segment}/${pfx}_ok/edit`, canDelete: false },
    ]);
  });

  it("VIEWER: sin acciones ni columna", async () => {
    rows();
    as(SUB_VIEWER_A);
    expect(await actionsOf()).toEqual([]);
    expect(await headers()).not.toContain("Acciones");
  });

  it("las acciones reciben sólo id, token, etiqueta y permisos (sin importes ni contraparte)", async () => {
    rows();
    for (const p of await actionsOf()) {
      expect(Object.keys(p).sort()).toEqual(["canDelete", "editHref", "invoiceId", "label", "updatedAt"]);
      expect(JSON.stringify(p)).not.toMatch(/1000|1210|Contraparte|30999999995/);
    }
  });

  it("key de cada fila de acciones incluye el token (se reinicia tras recargar)", async () => {
    const pfx = rows();
    const el = findAll(await call(), InvoiceRowActions)[0];
    expect(el.key).toBe(`${pfx}_ok-${T0}`);
  });

  it("montos de la lista sin cambios (misma vista que antes)", async () => {
    rows();
    const tds = findAll(await call(), "td").map((e) => textOf(e.props.children));
    expect(tds).toContain("$1.000,00");
    expect(tds).toContain("$210,00");
  });

  it("cada comprobante es una DeletableInvoiceRow (key e id; sin otros datos) dentro de DeletableInvoiceRows con la tabla", async () => {
    const pfx = rows();
    const el = await call();
    const wrappers = findAll(el, DeletableInvoiceRows);
    expect(wrappers).toHaveLength(1);
    expect(wrappers[0].props.label).toBe(direction === "SALES" ? "Lista de ventas" : "Lista de compras");
    expect(findAll(wrappers[0].props.children, "table")).toHaveLength(1);
    const rowEls = findAll(el, DeletableInvoiceRow);
    expect(rowEls.map((r) => r.key)).toEqual([`${pfx}_ok`, `${pfx}_nodata`, `${pfx}_imp`]);
    for (const r of rowEls) {
      expect(Object.keys(r.props).sort()).toEqual(["children", "invoiceId"]);
      expect(r.props.invoiceId).toBe(r.key);
    }
    // Las acciones siguen dentro de su fila.
    expect(findAll(rowEls[0].props.children, InvoiceRowActions)).toHaveLength(1);
  });

  it("lista vacía: fila de aviso común (no deletable), dentro del contenedor", async () => {
    setWorld([]);
    const el = await call();
    expect(findAll(el, DeletableInvoiceRow)).toHaveLength(0);
    expect(findAll(findAll(el, DeletableInvoiceRows)[0].props.children, "tr").length).toBeGreaterThan(0);
  });
});

describe("filas eliminables — retiro local tras el 204", () => {
  // children como argumentos de createElement (react/no-children-prop), sin tocar los props del componente.
  const h = (type: any, props: any, ...children: any[]) => createElement(type, props, ...children);
  const cells = createElement("td", null, "FC A 0001-00001001");
  const rowHtml = (deleted: boolean | null) => {
    const row = h(DeletableInvoiceRow, { invoiceId: "inv_1" }, cells);
    const tbody = createElement("tbody", null, row);
    const table = createElement("table", null, tbody);
    if (deleted === null) return renderToStaticMarkup(table);
    const value = { isDeleted: (id: string) => deleted && id === "inv_1", markDeleted: () => {} };
    return renderToStaticMarkup(createElement(InvoiceRowDeletionContext.Provider, { value }, table));
  };

  it("no eliminada -> <tr> con sus celdas (HTML de tabla válido)", () => {
    expect(rowHtml(false)).toBe("<table><tbody><tr><td>FC A 0001-00001001</td></tr></tbody></table>");
  });

  it("marcada como eliminada -> no se renderiza", () => {
    expect(rowHtml(true)).toBe("<table><tbody></tbody></table>");
  });

  it("sin contenedor -> se renderiza (no-op seguro)", () => {
    expect(rowHtml(null)).toContain("<tr><td>");
  });

  it("sólo se retira el id marcado", () => {
    const value = { isDeleted: (id: string) => id === "otro", markDeleted: () => {} };
    const html = renderToStaticMarkup(
      createElement(InvoiceRowDeletionContext.Provider, { value }, createElement("table", null, createElement("tbody", null, h(DeletableInvoiceRow, { invoiceId: "inv_1" }, cells)))),
    );
    expect(html).toContain("<tr>");
  });

  it("withDeletedRow agrega sin mutar e ignora duplicados", () => {
    const empty: ReadonlySet<string> = new Set();
    const one = withDeletedRow(empty, "a");
    expect([...one]).toEqual(["a"]);
    expect(empty.size).toBe(0);
    expect(withDeletedRow(one, "a")).toBe(one);
    expect([...withDeletedRow(one, "b")]).toEqual(["a", "b"]);
  });

  it("contenedor: región role=status vacía FUERA de la tabla y lista enfocable sin entrar al orden de tabulación", () => {
    const html = renderToStaticMarkup(h(DeletableInvoiceRows, { label: "Lista de ventas" }, createElement("table", null, createElement("tbody", null))));
    expect(html).toMatch(/^<div tabindex="-1" aria-label="Lista de ventas"[^>]*><table><tbody><\/tbody><\/table><\/div><p role="status" aria-live="polite"[^>]*><\/p>$/);
  });
});

describe("acciones de fila — render inicial", () => {
  const html = (p: Partial<Parameters<typeof InvoiceRowActions>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(InvoiceRowActions, { invoiceId: "inv_1", updatedAt: T0, label: "FC A 0001-00001001", editHref: "/x/edit", canDelete: true, ...p }),
    );

  it("editar (enlace) y eliminar (botón), sin confirmación abierta ni llamadas", () => {
    const h = html();
    expect(h).toContain('href="/x/edit"');
    expect(h).toContain('aria-label="Editar FC A 0001-00001001"');
    expect(h).toMatch(/<button type="button"[^>]*aria-label="Eliminar FC A 0001-00001001"/);
    expect(h).not.toContain("Confirmar eliminación");
    expect(h).toContain('aria-busy="false"');
  });

  it("sin permiso de baja -> sólo editar; sin ninguna -> nada", () => {
    expect(html({ canDelete: false })).not.toContain("Eliminar");
    expect(html({ editHref: null })).not.toContain("Editar");
    expect(html({ editHref: null, canDelete: false })).toBe("");
  });
});

describe("fuentes de UI de edición y baja", () => {
  const read = (p: string) => readFileSync(new URL(`../../app/(app)/client/[id]/period/[periodId]/${p}`, import.meta.url), "utf8");
  const actions = read("_components/invoice-row-actions.tsx");
  const deletable = read("_components/invoice-deletable-row.tsx");
  const form = read("_components/invoice-form.tsx");
  const pages = [read("sales/[invoiceId]/edit/page.tsx"), read("purchases/[invoiceId]/edit/page.tsx")];

  it("sin confirm/alert/prompt en componentes cliente", () => {
    for (const s of [actions, deletable, form]) expect(s).not.toMatch(/\b(window\.)?(confirm|alert|prompt)\s*\(/);
  });

  it("retiro de la fila sin manipulación directa del DOM ni recarga completa", () => {
    for (const s of [actions, deletable]) {
      expect(s).not.toMatch(/\bdocument\.|window\.location|location\.(reload|href|assign|replace)|\.remove\(\)|removeChild|innerHTML|style\.display/);
    }
    expect(deletable.startsWith('"use client";')).toBe(true);
  });

  it("componentes cliente sin Prisma ni módulos server-only", () => {
    for (const s of [actions, deletable, form]) {
      expect(s).not.toMatch(/@prisma\/client|["']server-only["']|@\/lib\/prisma\b|@\/lib\/(invoice-edit|invoice-form-context|invoice-write|invoice-lock|api-input)\b/);
    }
  });

  it("confirmación accesible en la página: grupo etiquetado, foco, aria-busy, estado y alertas", () => {
    expect(actions).toMatch(/role="group" aria-labelledby=\{promptId\}/);
    expect(actions).toMatch(/confirmButton\.current\?\.focus\(\)/);
    expect(actions).toMatch(/aria-busy=\{busy\}/);
    expect(actions).toMatch(/role="status"/);
    expect(actions).toMatch(/role="alert"/);
    expect(actions).toMatch(/disabled=\{busy\}/);
    // Doble clic: guardia compartido de lib (runExclusive) con la ref del componente.
    expect(actions).toMatch(/await runExclusive\(inFlight, async \(\) => \{/);
    // Sin borrado optimista: sólo tras el éxito, en orden: done -> markDeleted -> refresh.
    expect(actions).toMatch(
      /if \(!result\.ok\) \{\s*dispatch\(\{ type: "fail", feedback: result\.feedback \}\);\s*return;\s*\}\s*(\/\/[^\n]*\n\s*)?dispatch\(\{ type: "done" \}\);\s*markDeleted\(invoiceId, `Comprobante \$\{label\} eliminado\.`\);\s*router\.refresh\(\);/,
    );
    // markDeleted sólo aparece en el camino de éxito (ni en start, fail ni cancel).
    expect(actions.match(/markDeleted\(/g)).toHaveLength(1);
    expect(actions.indexOf('dispatch({ type: "start" })')).toBeLessThan(actions.indexOf("markDeleted("));
    expect(actions).toMatch(/onClick=\{\(\) => dispatch\(\{ type: "cancel" \}\)\}/);
  });

  it("edición: token actualizado tras el PATCH y redirección a la lista", () => {
    expect(form).toMatch(/token\.current = nextUpdateToken\(token\.current, result\);\s*\}[\s\S]*?router\.push\(listHref\);/);
    expect(form).toMatch(/const token = useRef\(edit\?\.updatedAt \?\? ""\);/);
  });

  it("las páginas de edición son Server Components con guardPage y el formulario compartido", () => {
    for (const [p, dir] of [
      [pages[0], "SALES"],
      [pages[1], "PURCHASES"],
    ] as const) {
      expect(p).not.toMatch(/["']use client["']/);
      expect(p).toContain(`guardPage(() => loadInvoiceEditContext(id, periodId, invoiceId, "${dir}"))`);
      expect(p).toContain(`<InvoiceForm key={edit.form.updatedAt} direction="${dir}"`);
    }
  });
});

describe("regresión del alta", () => {
  it("el formulario sin `edit` sigue siendo el alta (título, botón, POST)", () => {
    const h = renderToStaticMarkup(
      createElement(InvoiceForm, {
        direction: "SALES",
        clientId: "c_a",
        periodId: "p_a",
        clientName: "Alfa SA",
        period: { month: 5, year: 2026 },
        clientConditionCode: 1,
        turivaIncluded: false,
      }),
    );
    expect(h).toContain("Nueva venta");
    expect(h).toContain("Guardar venta");
    expect(h).not.toMatch(/Editar venta|Guardar cambios|sin la condición|sin la variante/);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
