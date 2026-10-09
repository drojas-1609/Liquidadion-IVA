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
  closePeriodInWorld,
} from "../api/_harness";
import { PeriodClosedNotice } from "@/app/(app)/client/[id]/period/[periodId]/_components/period-closed-notice";
import NewSalePage from "@/app/(app)/client/[id]/period/[periodId]/sales/new/page";
import NewPurchasePage from "@/app/(app)/client/[id]/period/[periodId]/purchases/new/page";
import { InvoiceForm, type InvoiceFormProps } from "@/app/(app)/client/[id]/period/[periodId]/_components/invoice-form";
import { AccessNotice } from "@/app/_components/access-notice";
import { TurivaSetting } from "@/app/(app)/client/[id]/period/[periodId]/turiva-setting";
import { TURIVA_SECTION_ID } from "@/lib/turiva-setting";

let db: ReturnType<typeof freshDbMock>;

const setWorld = (patch: (w: World) => void = () => {}) => {
  const w = makeWorld({
    clients: [clientRow("c_a", ORG_A, { name: "Alfa SA" }), clientRow("c_other", ORG_A), clientRow("c_b", ORG_B)],
    periods: [periodRow("p_a", "c_a", ORG_A), periodRow("p_b", "c_b", ORG_B)],
  });
  patch(w);
  wireDb(db, w, freshRecorder());
};

beforeEach(() => {
  db = freshDbMock();
  setWorld();
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

/* eslint-disable @typescript-eslint/no-explicit-any */
const noticeOf = (el: any): string | null => (el && el.type === AccessNotice ? el.props.notice : null);
/* eslint-enable @typescript-eslint/no-explicit-any */

const PAGES = [
  ["ventas", NewSalePage, "SALES"],
  ["compras", NewPurchasePage, "PURCHASES"],
] as const;

describe.each(PAGES)("página servidor de alta (%s)", (_name, Page, direction) => {
  const call = (id = "c_a", periodId = "p_a") => Page({ params: Promise.resolve({ id, periodId }) });

  it.each([
    ["OWNER", SUB_OWNER_A],
    ["ADMIN", SUB_ADMIN_A],
    ["ACCOUNTANT", SUB_ACCOUNTANT_A],
  ])("%s -> formulario compartido con props EXACTAS (sin organización, rol ni autoría)", async (_role, sub) => {
    H.claims.value = claimsFor(sub);
    const el = await call();
    expect(noticeOf(el)).toBeNull();
    expect(el.type).toBe(InvoiceForm);
    expect(el.props).toEqual({
      direction,
      clientId: "c_a",
      periodId: "p_a",
      clientName: "Alfa SA",
      period: { month: 5, year: 2026 },
      clientConditionCode: 1,
      turivaIncluded: false,
    });
  });

  it("VIEWER -> aviso de permisos, sin formulario", async () => {
    H.claims.value = claimsFor(SUB_VIEWER_A);
    expect(noticeOf(await call())).toBe("forbidden");
  });

  it("período de otra organización, de otro cliente o inexistente -> notFound()", async () => {
    await expect(call("c_b", "p_b")).rejects.toThrow("NOTFOUND_PAGE");
    await expect(call("c_other", "p_a")).rejects.toThrow("NOTFOUND_PAGE");
    await expect(call("c_a", "p_zzz")).rejects.toThrow("NOTFOUND_PAGE");
    H.claims.value = claimsFor(SUB_OWNER_B);
    await expect(call()).rejects.toThrow("NOTFOUND_PAGE");
  });

  it("sin sesión -> redirect('/login')", async () => {
    H.claims.value = null;
    await expect(call()).rejects.toThrow("REDIRECT:/login");
  });

  it("turivaIncluded: false sin PeriodVatSettings; el valor guardado si existe", async () => {
    setWorld((w) => (w.vatSettings = [{ periodId: "p_a", organizationId: ORG_A, turivaIncluded: true }]));
    expect((await call()).props.turivaIncluded).toBe(true);
    setWorld((w) => (w.vatSettings = [{ periodId: "p_a", organizationId: ORG_A, turivaIncluded: false }]));
    expect((await call()).props.turivaIncluded).toBe(false);
  });

  it("condición del cliente: código oficial; texto no admitido -> null (el formulario bloquea)", async () => {
    setWorld((w) => (w.clients[0].condition = "Monotributo"));
    expect((await call()).props.clientConditionCode).toBe(6);
    setWorld((w) => (w.clients[0].condition = "Consumidor Final"));
    expect((await call()).props.clientConditionCode).toBeNull();
  });

  it("todas las lecturas filtran por organizationId", async () => {
    await call();
    expect(db.period.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "p_a", organizationId: ORG_A }, select: { month: true, year: true } }));
    expect(db.client.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c_a", organizationId: ORG_A }, select: { name: true, condition: true } }));
    expect(db.periodVatSettings.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { periodId_organizationId: { periodId: "p_a", organizationId: ORG_A } }, select: { turivaIncluded: true } }),
    );
  });
});

describe("formulario compartido — render inicial (sin base real)", () => {
  const props = (over: Partial<InvoiceFormProps> = {}): InvoiceFormProps => ({
    direction: "SALES",
    clientId: "c_a",
    periodId: "p_a",
    clientName: "Alfa SA",
    period: { month: 5, year: 2026 },
    clientConditionCode: 1,
    turivaIncluded: false,
    ...over,
  });
  const html = (over: Partial<InvoiceFormProps> = {}) => renderToStaticMarkup(createElement(InvoiceForm, props(over)));

  it("cada control tiene label asociado y los campos siguen el orden fecha -> contraparte -> comprobante -> documento", () => {
    const h = html();
    const ids = ["invoice-date", "invoice-counterparty-condition", "invoice-voucher-code", "invoice-doc-type", "invoice-doc-number", "invoice-counterparty-name", "invoice-point-of-sale", "invoice-number", "invoice-net-amount", "invoice-vat-rate"];
    for (const id of ids) {
      expect(h, id).toContain(`for="${id}"`);
      expect(h, id).toContain(`id="${id}"`);
    }
    const pos = ids.slice(0, 5).map((id) => h.indexOf(`id="${id}"`));
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });

  it("sin fecha: selects dependientes deshabilitados con ayuda asociada y guardado deshabilitado", () => {
    const h = html();
    expect(h).toMatch(/<select[^>]*id="invoice-counterparty-condition"[^>]*disabled=""/);
    expect(h).toMatch(/aria-describedby="invoice-counterparty-condition-help"/);
    expect(h).toContain('id="invoice-counterparty-condition-help"');
    expect(h).toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it("límites de fecha del período y punto de venta / número como texto numérico (no type=number)", () => {
    const h = html();
    expect(h).toMatch(/id="invoice-date"[^>]*min="2026-05-01"[^>]*max="2026-05-31"|min="2026-05-01"[^>]*max="2026-05-31"[^>]*id="invoice-date"/);
    for (const id of ["invoice-point-of-sale", "invoice-number"]) {
      const tag = h.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? "";
      expect(tag, id).toContain('type="text"');
      expect(tag, id).toContain('inputMode="numeric"');
      expect(tag, id).toContain('pattern="[0-9]*"');
    }
    expect(h).not.toContain('type="number"');
    const purchases = html({ direction: "PURCHASES" });
    expect(purchases).not.toMatch(/id="invoice-date"[^>]*min=/);
  });

  it("sin previsualización local de IVA ni total", () => {
    const h = html();
    expect(h).not.toMatch(/IVA Calculado|previsualización|Total \(/i);
  });

  it("condición del cliente no admitida -> bloqueo explícito, controles y envío deshabilitados", () => {
    const h = html({ clientConditionCode: null });
    expect(h).toMatch(/role="alert"[^>]*>No se pueden cargar comprobantes para este cliente/);
    expect(h).toContain('href="/client/c_a/edit"');
    expect(h).toMatch(/<input[^>]*id="invoice-date"[^>]*disabled=""/);
    expect(h).toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it("textos y rutas de retorno separados para ventas y compras", () => {
    const sales = html();
    expect(sales).toContain("Nueva venta");
    expect(sales).toContain('href="/client/c_a/period/p_a/sales"');
    expect(sales).toContain("Período 05/2026");
    const purchases = html({ direction: "PURCHASES" });
    expect(purchases).toContain("Nueva compra");
    expect(purchases).toContain('href="/client/c_a/period/p_a/purchases"');
    expect(purchases).toContain("Proveedor (razón social)");
  });

  it("no incluye el interruptor TurIVA (vive en la página del período)", () => {
    expect(html()).not.toMatch(/turivaIncluded|Incluir operaciones TurIVA/);
  });

  it("el aviso TURIVA_NOT_INCLUDED enlaza a la ubicación real del control (#turiva de la página del período)", () => {
    const src = readFileSync(new URL("../../app/(app)/client/[id]/period/[periodId]/_components/invoice-form.tsx", import.meta.url), "utf8");
    const notice = src.slice(src.indexOf('n.code === "TURIVA_NOT_INCLUDED"'));
    expect(notice).toMatch(/href=\{`\$\{periodHref\}#\$\{TURIVA_SECTION_ID\}`\}/);
    expect(src).toMatch(/const periodHref = `\/client\/\$\{clientId\}\/period\/\$\{periodId\}`;/);
    // El mismo id lo renderiza la tarjeta TurIVA de la página del período.
    expect(TURIVA_SECTION_ID).toBe("turiva");
    const card = renderToStaticMarkup(createElement(TurivaSetting, { periodId: "p_a", turivaIncluded: false, canEdit: true }));
    expect(card).toContain(`id="${TURIVA_SECTION_ID}"`);
  });
});

describe("fuentes de UI del formulario compartido", () => {
  const src = readFileSync(new URL("../../app/(app)/client/[id]/period/[periodId]/_components/invoice-form.tsx", import.meta.url), "utf8");
  const pages = ["sales", "purchases"].map((d) =>
    readFileSync(new URL(`../../app/(app)/client/[id]/period/[periodId]/${d}/new/page.tsx`, import.meta.url), "utf8"),
  );

  it("sin confirm/alert/prompt, 'período' con tilde, sin parseFloat", () => {
    expect(src).not.toMatch(/\b(window\.)?(confirm|alert|prompt)\s*\(/);
    expect(src).not.toMatch(/[Pp]eriodo/);
    expect(src).not.toMatch(/parseFloat/);
  });

  it("evita dobles envíos (ref en vuelo + aria-busy + botón deshabilitado)", () => {
    expect(src).toMatch(/inFlight\.current/);
    expect(src).toMatch(/aria-busy=\{loading\}/);
    expect(src).toMatch(/disabled=\{!canSubmit\}/);
    expect(src).toMatch(/const canSubmit = !loading/);
  });

  it("las páginas son Server Components (sin 'use client') que usan guardPage y el formulario compartido", () => {
    for (const p of pages) {
      expect(p).not.toMatch(/["']use client["']/);
      expect(p).toMatch(/guardPage\(\(\) => loadInvoiceFormContext\(id, periodId\)\)/);
      expect(p).toMatch(/<InvoiceForm direction="(SALES|PURCHASES)"/);
    }
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
describe.each(PAGES)("página servidor de alta (%s) — período cerrado", (_name, Page) => {
  const call = () => Page({ params: Promise.resolve({ id: "c_a", periodId: "p_a" }) });

  it.each([
    ["OWNER", SUB_OWNER_A],
    ["ACCOUNTANT", SUB_ACCOUNTANT_A],
  ])("%s -> aviso de período cerrado, sin formulario", async (_r, sub) => {
    H.claims.value = claimsFor(sub);
    setWorld((w) => closePeriodInWorld(w, "p_a"));
    const el: any = await call();
    expect(el.type).toBe(PeriodClosedNotice);
    expect(el.props).toEqual({ clientId: "c_a", periodId: "p_a" });
  });

  it("VIEWER -> aviso de permisos (el rol se evalúa primero)", async () => {
    H.claims.value = claimsFor(SUB_VIEWER_A);
    setWorld((w) => closePeriodInWorld(w, "p_a"));
    expect(noticeOf(await call())).toBe("forbidden");
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
