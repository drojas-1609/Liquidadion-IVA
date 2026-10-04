import ts from "typescript";

/**
 * Analizador estructural (AST de TypeScript, sin type-check) del bloqueo del
 * período. Inventario CERRADO: toda construcción no reconocida o no evaluable
 * estáticamente es una violación que exige revisión.
 *
 * `analyzeSource(file, src, methods)` devuelve las violaciones de UN archivo:
 *  - globales (todo archivo productivo): $queryRaw inventariado, raw
 *    prohibidos, accesos por corchetes / dinámicos / alias de modelos,
 *    escrituras anidadas desde Period, transacciones por lotes o con timeout
 *    ≤ 3000 ms o no evaluable, PrismaClient con transactionOptions.timeout
 *    ≤ 3000 ms o no evaluable, PeriodBusyError fuera del helper;
 *  - de inventario: escrituras fuera de los handlers inventariados;
 *  - por handler inventariado: transacción interactiva única con opciones
 *    LITERALES `{ maxWait: 5000, timeout: 10000 }`, lockPeriodForWrite como
 *    primera operación awaited, único, y nada dependiente antes;
 *  - de lib/period-lock.ts: secuencia lock_timeout -> FOR UPDATE -> restauración;
 *  - de lib/tax-record-lock.ts: un único FOR UPDATE de TaxRecord con columnas y
 *    parámetros exactos, sin Period; el helper sólo se usa dentro de handlers
 *    inventariados, después del lock de Period y antes de toda escritura de
 *    TaxRecord (update/delete) y del AuditLog del handler.
 */

export type ViolationCode =
  | "RAW_BANNED"
  | "RAW_FORM"
  | "RAW_NOT_INVENTORIED"
  | "RAW_MISSING"
  | "BRACKET_MODEL"
  | "DYNAMIC_ACCESS"
  | "MODEL_ALIAS"
  | "CLIENT_ALIAS"
  | "NESTED_WRITE"
  | "TX_BATCH"
  | "TX_NOT_INTERACTIVE"
  | "TX_TIMEOUT_LOW"
  | "TX_TIMEOUT_UNEVALUABLE"
  | "TX_OPTIONS_MISSING"
  | "TX_OPTIONS_UNEVALUABLE"
  | "TX_OPTIONS_UNEXPECTED"
  | "TX_MAX_WAIT_MISSING"
  | "TX_MAX_WAIT_INVALID"
  | "TX_MAX_WAIT_UNEVALUABLE"
  | "TX_MAX_WAIT_DUPLICATE"
  | "TX_TIMEOUT_MISSING"
  | "TX_TIMEOUT_INVALID"
  | "TX_TIMEOUT_DUPLICATE"
  | "BUSY_OUTSIDE_HELPER"
  | "WRITE_OUTSIDE_INVENTORY"
  | "WRITE_IN_PRELUDE"
  | "WRITE_IN_UNLISTED_HANDLER"
  | "HANDLER_MISSING"
  | "HANDLER_NO_TX"
  | "HANDLER_MULTI_TX"
  | "NO_WRITES"
  | "LOCK_NOT_FIRST"
  | "LOCK_ARGS"
  | "LOCK_COUNT"
  | "BEFORE_LOCK"
  | "WRITE_OUTSIDE_TX"
  | "LOCK_QUERY_MISSING"
  | "TIMEOUT_READ_MISSING"
  | "READ_AFTER_SET"
  | "TIMEOUT_SET_MISSING"
  | "TIMEOUT_SET_DUPLICATE"
  | "TIMEOUT_NOT_3000"
  | "TIMEOUT_NOT_LOCAL"
  | "RESTORE_MISSING"
  | "RESTORE_FIXED"
  | "RESTORE_BEFORE_LOCK"
  | "RESTORE_NOT_LOCAL"
  | "NOTFOUND_BEFORE_RESTORE"
  | "BUSY_TRANSLATION"
  | "TAX_RECORD_LOCK_PERIOD"
  | "TAX_RECORD_LOCK_OUTSIDE_INVENTORY"
  | "TAX_RECORD_LOCK_MISSING"
  | "TAX_RECORD_WRITE_BEFORE_LOCK";

export interface Violation {
  code: ViolationCode;
  detail: string;
}

/** Modelos del contenido del período: toda operación de escritura cuenta. */
const CONTENT_MODELS = new Set(["invoice", "invoiceVatLine", "taxRecord", "periodVatSettings"]);
const WRITE_OPS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);
/** Period: cuentan como escritura del contenido la baja y la modificación (no el alta). */
const PERIOD_WRITE_OPS = new Set(["delete", "deleteMany", "update", "updateMany", "updateManyAndReturn", "upsert"]);
/** Operaciones de Period que pueden anidar escrituras del contenido. */
const PERIOD_NESTING_OPS = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert"]);
/** Relaciones de Period hacia el contenido. */
const PERIOD_CONTENT_RELATIONS = new Set(["invoices", "invoicesByClient", "taxRecords", "vatSettings"]);
/** Identificadores que designan un cliente Prisma (o la transacción). */
const CLIENT_NAMES = new Set(["prisma", "tx", "db"]);
const BANNED_RAW = new Set(["$executeRaw", "$executeRawUnsafe", "$queryRawUnsafe"]);
const HANDLER_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Opciones exigidas, como texto literal del fuente, en la transacción de cada
 * handler inventariado: `{ maxWait: 5000, timeout: 10000 }`.
 */
const HANDLER_TX_OPTIONS = [
  { key: "maxWait", literal: "5000", missing: "TX_MAX_WAIT_MISSING", invalid: "TX_MAX_WAIT_INVALID", unevaluable: "TX_MAX_WAIT_UNEVALUABLE", duplicate: "TX_MAX_WAIT_DUPLICATE" },
  { key: "timeout", literal: "10000", missing: "TX_TIMEOUT_MISSING", invalid: "TX_TIMEOUT_INVALID", unevaluable: "TX_TIMEOUT_UNEVALUABLE", duplicate: "TX_TIMEOUT_DUPLICATE" },
] as const satisfies ReadonlyArray<{ key: string; literal: string; missing: ViolationCode; invalid: ViolationCode; unevaluable: ViolationCode; duplicate: ViolationCode }>;

// ── SQL inventariado ───────────────────────────────────────────────────────

const READ_TIMEOUT_SQL = `SELECT current_setting('lock_timeout') AS "lockTimeout"`;
const SET_CONFIG_SQL = /^SELECT set_config\('lock_timeout', ('[^']*'|\?), (true|false)\)$/;
const PERIOD_LOCK_SQL = `SELECT "id" FROM "Period" WHERE "id" = ? AND "organizationId" = ? FOR UPDATE`;
const INVOICE_LOCK_SQL = /^SELECT (?:"\w+", )*"\w+" FROM "Invoice" WHERE "id" = \? AND "organizationId" = \? FOR UPDATE$/;
/** FOR UPDATE de TaxRecord: columnas y orden EXACTOS. */
const TAX_RECORD_LOCK_SQL =
  'SELECT "id", "organizationId", "periodId", "type", "date", "amount", "description", "updatedAt" FROM "TaxRecord" WHERE "id" = ? AND "organizationId" = ? FOR UPDATE';
const TAX_RECORD_LOCK_FILE = "lib/tax-record-lock.ts";
const TAX_RECORD_LOCK_FN = "lockTaxRecordForUpdate";
/** Escrituras de TaxRecord que exigen la fila bloqueada (el alta no). */
const TAX_RECORD_ROW_WRITE_OPS = new Set(["update", "updateMany", "updateManyAndReturn", "upsert", "delete", "deleteMany"]);

// ── utilidades AST ─────────────────────────────────────────────────────────

function parse(file: string, src: string): ts.SourceFile {
  return ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isTypeAssertionExpression(cur)) {
      cur = cur.expression;
    } else return cur;
  }
}

function forEachNode(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  node.forEachChild((c) => forEachNode(c, fn));
}

const isStringLit = (e: ts.Node): e is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e);

/** Nombre de miembro de `a.b` o `a["b"]`; null si es dinámico. */
function memberName(n: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n) && isStringLit(n.argumentExpression)) return n.argumentExpression.text;
  return null;
}

const isClientIdent = (e: ts.Expression) => {
  const u = unwrap(e);
  return ts.isIdentifier(u) && CLIENT_NAMES.has(u.text);
};

const text = (sf: ts.SourceFile, n: ts.Node) => n.getText(sf);

interface Ctx {
  file: string;
  sf: ts.SourceFile;
  v: Violation[];
  /** Alias locales de modelos: nombre -> modelo. */
  modelAliases: Map<string, string>;
}

const add = (ctx: Ctx, code: ViolationCode, node: ts.Node | null, msg: string): void => {
  ctx.v.push({ code, detail: `${ctx.file}${node ? `:${ctx.sf.getLineAndCharacterOfPosition(node.getStart(ctx.sf)).line + 1}` : ""}: ${msg}` });
};

/**
 * Modelo designado por `node` (acceso `x.model` / `x["model"]`, o alias), o
 * null. `period` sólo cuenta sobre un cliente Prisma (evita `access.period`).
 */
function modelOf(ctx: Ctx, node: ts.Expression): string | null {
  const u = unwrap(node);
  if (ts.isIdentifier(u)) return ctx.modelAliases.get(u.text) ?? null;
  const name = memberName(u);
  if (name === null) return null;
  if (CONTENT_MODELS.has(name)) return name;
  if (name === "period" && isClientIdent((u as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression)) return name;
  return null;
}

/** Llamada `<modelo>.<op>(...)`: { model, op } o null. */
function modelCall(ctx: Ctx, call: ts.CallExpression): { model: string; op: string } | null {
  const callee = unwrap(call.expression);
  const op = memberName(callee);
  if (op === null) return null;
  const model = modelOf(ctx, (callee as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression);
  return model ? { model, op } : null;
}

function isWriteCall(ctx: Ctx, call: ts.CallExpression): boolean {
  const mc = modelCall(ctx, call);
  if (!mc) return false;
  return mc.model === "period" ? PERIOD_WRITE_OPS.has(mc.op) : WRITE_OPS.has(mc.op);
}

const calleeName = (call: ts.CallExpression): string | null => {
  const c = unwrap(call.expression);
  return ts.isIdentifier(c) ? c.text : null;
};

function* calls(node: ts.Node): Generator<ts.CallExpression> {
  const out: ts.CallExpression[] = [];
  forEachNode(node, (n) => {
    if (ts.isCallExpression(n)) out.push(n);
  });
  yield* out;
}

const isFunctionLike = (e: ts.Expression) => ts.isArrowFunction(e) || ts.isFunctionExpression(e);

// ── chequeos globales ──────────────────────────────────────────────────────

function collectModelAliases(ctx: Ctx): void {
  forEachNode(ctx.sf, (n) => {
    if (!ts.isVariableDeclaration(n) || !n.initializer) return;
    if (ts.isIdentifier(n.name)) {
      const model = modelOf({ ...ctx, modelAliases: new Map() }, n.initializer);
      if (model) ctx.modelAliases.set(n.name.text, model);
    } else if (ts.isObjectBindingPattern(n.name) && isClientIdent(n.initializer)) {
      for (const el of n.name.elements) {
        const prop = el.propertyName && (ts.isIdentifier(el.propertyName) || isStringLit(el.propertyName)) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : null;
        if (prop && (CONTENT_MODELS.has(prop) || prop === "period") && ts.isIdentifier(el.name)) ctx.modelAliases.set(el.name.text, prop);
      }
    }
  });
}

function checkAccessAndAliases(ctx: Ctx): void {
  forEachNode(ctx.sf, (n) => {
    // Accesos por corchetes sobre un cliente o un modelo.
    if (ts.isElementAccessExpression(n)) {
      const obj = n.expression;
      const literal = isStringLit(n.argumentExpression) ? n.argumentExpression.text : null;
      if (isClientIdent(obj)) {
        if (literal !== null && (CONTENT_MODELS.has(literal) || literal === "period")) add(ctx, "BRACKET_MODEL", n, `acceso por corchetes al modelo ${literal}`);
        else add(ctx, "DYNAMIC_ACCESS", n, `acceso por corchetes no inventariado sobre el cliente: ${text(ctx.sf, n)}`);
      } else if (modelOf(ctx, obj) && literal === null) {
        add(ctx, "DYNAMIC_ACCESS", n, `operación dinámica sobre un modelo: ${text(ctx.sf, n)}`);
      }
    }

    // Modelo usado como valor (alias / escape), no como receptor de una operación.
    if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && modelOf({ ...ctx, modelAliases: new Map() }, n)) {
      let p: ts.Node = n.parent;
      let child: ts.Node = n;
      while (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p) || ts.isAsExpression(p)) {
        child = p;
        p = p.parent;
      }
      const usedAsReceiver = (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === child;
      if (!usedAsReceiver) add(ctx, "MODEL_ALIAS", n, `modelo usado como valor (alias): ${text(ctx.sf, n)}`);
    }

    // Desestructuración de un cliente.
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isObjectBindingPattern(n.name) && isClientIdent(n.initializer)) {
      for (const el of n.name.elements) {
        const prop = el.propertyName && (ts.isIdentifier(el.propertyName) || isStringLit(el.propertyName)) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : null;
        if (prop && (CONTENT_MODELS.has(prop) || prop === "period")) add(ctx, "MODEL_ALIAS", el, `modelo desestructurado del cliente: ${prop}`);
        else add(ctx, "CLIENT_ALIAS", el, `desestructuración no inventariada del cliente: ${text(ctx.sf, el)}`);
      }
    }
  });
}

/** Alias del cliente (`const t = tx`, `t = prisma`) dentro de `scope`. */
function checkClientAliases(ctx: Ctx, scope: ts.Node): void {
  forEachNode(scope, (n) => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name) && isClientIdent(n.initializer)) {
      add(ctx, "CLIENT_ALIAS", n, `alias del cliente: ${text(ctx.sf, n)}`);
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && isClientIdent(n.right)) {
      add(ctx, "CLIENT_ALIAS", n, `alias del cliente: ${text(ctx.sf, n)}`);
    }
  });
}

/** Relaciones del contenido (o forma no evaluable) dentro de los argumentos de una escritura de Period. */
function checkNestedWrites(ctx: Ctx): void {
  for (const call of calls(ctx.sf)) {
    const mc = modelCall(ctx, call);
    if (!mc || mc.model !== "period" || !PERIOD_NESTING_OPS.has(mc.op)) continue;
    for (const arg of call.arguments) {
      const a = unwrap(arg);
      if (!ts.isObjectLiteralExpression(a)) {
        add(ctx, "NESTED_WRITE", arg, `period.${mc.op} con argumentos no evaluables`);
        continue;
      }
      forEachNode(a, (n) => {
        if (ts.isSpreadAssignment(n)) add(ctx, "NESTED_WRITE", n, `period.${mc.op} con spread no evaluable`);
        if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && n.name && (ts.isIdentifier(n.name) || isStringLit(n.name)) && PERIOD_CONTENT_RELATIONS.has(n.name.text)) {
          add(ctx, "NESTED_WRITE", n, `period.${mc.op} anida la relación ${n.name.text}`);
        }
      });
    }
  }
}

/** Valor numérico de `timeout` en un objeto literal: número, "absent" o "unevaluable". */
function timeoutOf(obj: ts.Expression): number | "absent" | "unevaluable" {
  const o = unwrap(obj);
  if (!ts.isObjectLiteralExpression(o)) return "unevaluable";
  let result: number | "absent" | "unevaluable" = "absent";
  for (const p of o.properties) {
    if (ts.isSpreadAssignment(p)) return "unevaluable";
    const name = p.name && (ts.isIdentifier(p.name) || isStringLit(p.name)) ? p.name.text : null;
    if (name === null) return "unevaluable";
    if (name !== "timeout") continue;
    if (!ts.isPropertyAssignment(p)) return "unevaluable";
    const init = unwrap(p.initializer);
    if (!ts.isNumericLiteral(init)) return "unevaluable";
    result = Number(init.text);
  }
  return result;
}

/**
 * `handlerTx`: transacciones de handlers inventariados; sus opciones las evalúa
 * (con reglas más estrictas) `checkHandlerTxOptions`, así cada infracción da
 * un único código.
 */
function checkTransactions(ctx: Ctx, handlerTx: ReadonlySet<ts.CallExpression>): void {
  for (const call of calls(ctx.sf)) {
    if (memberName(unwrap(call.expression)) !== "$transaction") continue;
    const first = call.arguments[0] ? unwrap(call.arguments[0]) : null;
    if (first && ts.isArrayLiteralExpression(first)) add(ctx, "TX_BATCH", call, "$transaction([...]) por lotes");
    else if (!first || !isFunctionLike(first)) add(ctx, "TX_NOT_INTERACTIVE", call, "$transaction sin callback interactivo");
    if (handlerTx.has(call)) continue;
    const opts = call.arguments[1];
    if (opts) {
      const t = timeoutOf(opts);
      if (t === "unevaluable") add(ctx, "TX_TIMEOUT_UNEVALUABLE", opts, "opciones de $transaction no evaluables");
      else if (t !== "absent" && t <= 3000) add(ctx, "TX_TIMEOUT_LOW", opts, `timeout de transacción ${t} ms ≤ 3000 ms (lock_timeout)`);
    }
    if (call.arguments.length > 2) add(ctx, "TX_TIMEOUT_UNEVALUABLE", call, "$transaction con argumentos no inventariados");
  }

  forEachNode(ctx.sf, (n) => {
    if (!ts.isNewExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== "PrismaClient") return;
    const arg = n.arguments?.[0];
    if (!arg) return;
    const o = unwrap(arg);
    if (!ts.isObjectLiteralExpression(o)) return add(ctx, "TX_TIMEOUT_UNEVALUABLE", arg, "opciones de PrismaClient no evaluables");
    for (const p of o.properties) {
      if (ts.isSpreadAssignment(p)) return add(ctx, "TX_TIMEOUT_UNEVALUABLE", p, "opciones de PrismaClient con spread");
      const name = p.name && (ts.isIdentifier(p.name) || isStringLit(p.name)) ? p.name.text : null;
      if (name !== "transactionOptions") continue;
      if (!ts.isPropertyAssignment(p)) return add(ctx, "TX_TIMEOUT_UNEVALUABLE", p, "transactionOptions no evaluable");
      const t = timeoutOf(p.initializer);
      if (t === "unevaluable") add(ctx, "TX_TIMEOUT_UNEVALUABLE", p, "transactionOptions no evaluable");
      else if (t !== "absent" && t <= 3000) add(ctx, "TX_TIMEOUT_LOW", p, `transactionOptions.timeout ${t} ms ≤ 3000 ms (lock_timeout)`);
    }
  });
}

interface RawQuery {
  node: ts.TaggedTemplateExpression;
  sql: string;
  params: string[];
  pos: number;
}

/** $queryRaw en tagged template; cualquier otra forma, o los raw prohibidos, son violaciones. */
function collectRaw(ctx: Ctx): RawQuery[] {
  const out: RawQuery[] = [];
  forEachNode(ctx.sf, (n) => {
    if ((ts.isIdentifier(n) || ts.isPrivateIdentifier(n) || isStringLit(n)) && BANNED_RAW.has(n.text)) {
      add(ctx, "RAW_BANNED", n, `${n.text} prohibido`);
    }
    if (!(ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) || memberName(n) !== "$queryRaw") return;
    const parent = n.parent;
    if (!ts.isTaggedTemplateExpression(parent) || parent.tag !== n) {
      add(ctx, "RAW_FORM", n, `$queryRaw fuera de un tagged template: ${text(ctx.sf, parent)}`);
      return;
    }
    const tpl = parent.template;
    let sql: string;
    const params: string[] = [];
    if (ts.isNoSubstitutionTemplateLiteral(tpl)) sql = tpl.text;
    else {
      sql = tpl.head.text;
      for (const span of tpl.templateSpans) {
        params.push(text(ctx.sf, span.expression));
        sql += "?" + span.literal.text;
      }
    }
    out.push({ node: parent, sql: sql.replace(/\s+/g, " ").trim(), params, pos: parent.getStart(ctx.sf) });
  });
  return out;
}

function checkRawInventory(ctx: Ctx, raws: RawQuery[]): void {
  if (ctx.file === "lib/period-lock.ts") {
    for (const r of raws) {
      const shape =
        (r.sql === READ_TIMEOUT_SQL && r.params.length === 0) ||
        (SET_CONFIG_SQL.test(r.sql) && r.params.length === (r.sql.includes("?") ? 1 : 0)) ||
        (r.sql === PERIOD_LOCK_SQL && r.params.join(",") === "periodId,organizationId");
      if (!shape) add(ctx, "RAW_NOT_INVENTORIED", r.node, `$queryRaw no inventariado: ${r.sql}`);
    }
    return;
  }
  if (ctx.file === "lib/invoice-lock.ts") {
    const ok = raws.filter((r) => INVOICE_LOCK_SQL.test(r.sql) && r.params.join(",") === "invoiceId,organizationId");
    for (const r of raws) if (!ok.includes(r)) add(ctx, "RAW_NOT_INVENTORIED", r.node, `$queryRaw no inventariado: ${r.sql}`);
    if (ok.length === 0) add(ctx, "RAW_MISSING", null, "falta el FOR UPDATE de Invoice");
    if (ok.length > 1) for (const r of ok.slice(1)) add(ctx, "RAW_NOT_INVENTORIED", r.node, `FOR UPDATE de Invoice repetido`);
    return;
  }
  if (ctx.file === TAX_RECORD_LOCK_FILE) {
    // Una consulta por infracción: la que menciona Period es TAX_RECORD_LOCK_PERIOD;
    // cualquier otra distinta de la inventariada, RAW_NOT_INVENTORIED; sin
    // ninguna consulta, RAW_MISSING.
    let ok = 0;
    for (const r of raws) {
      if (/"Period"/.test(r.sql)) add(ctx, "TAX_RECORD_LOCK_PERIOD", r.node, `el lock de TaxRecord consulta Period: ${r.sql}`);
      else if (r.sql !== TAX_RECORD_LOCK_SQL || r.params.join(",") !== "taxRecordId,organizationId") {
        add(ctx, "RAW_NOT_INVENTORIED", r.node, `$queryRaw no inventariado: ${r.sql} [${r.params.join(", ")}]`);
      } else if (++ok > 1) add(ctx, "RAW_NOT_INVENTORIED", r.node, "FOR UPDATE de TaxRecord repetido");
    }
    if (raws.length === 0) add(ctx, "RAW_MISSING", null, "falta el FOR UPDATE de TaxRecord");
    return;
  }
  for (const r of raws) add(ctx, "RAW_NOT_INVENTORIED", r.node, `$queryRaw fuera de lib/period-lock.ts, lib/invoice-lock.ts y lib/tax-record-lock.ts: ${r.sql}`);
}

/** lib/tax-record-lock.ts no bloquea ni lee Period (el Period lo bloquea la ruta, antes). */
function checkTaxRecordLockHelper(ctx: Ctx): void {
  for (const c of calls(ctx.sf)) {
    const name = calleeName(c);
    if (name === "lockPeriodForWrite" || name === "lockPeriodForUpdate") {
      add(ctx, "TAX_RECORD_LOCK_PERIOD", c, `el lock de TaxRecord bloquea Period: ${text(ctx.sf, c.expression)}`);
    } else if (modelCall(ctx, c)?.model === "period") {
      add(ctx, "TAX_RECORD_LOCK_PERIOD", c, `el lock de TaxRecord usa Period: ${text(ctx.sf, c.expression)}`);
    }
  }
}

function checkBusyOutsideHelper(ctx: Ctx): void {
  if (ctx.file === "lib/period-lock.ts") return;
  forEachNode(ctx.sf, (n) => {
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "PeriodBusyError") {
      add(ctx, "BUSY_OUTSIDE_HELPER", n, "PeriodBusyError sólo lo construye lockPeriodForWrite");
    }
  });
}

// ── lib/period-lock.ts: secuencia del helper ───────────────────────────────

function checkLockHelper(ctx: Ctx, raws: RawQuery[]): void {
  const lock = raws.find((r) => r.sql === PERIOD_LOCK_SQL);
  if (!lock) {
    add(ctx, "LOCK_QUERY_MISSING", null, "falta el SELECT … FOR UPDATE de Period");
    return;
  }
  const reads = raws.filter((r) => r.sql === READ_TIMEOUT_SQL);
  const setConfigs = raws
    .map((r) => ({ r, m: SET_CONFIG_SQL.exec(r.sql) }))
    .filter((x): x is { r: RawQuery; m: RegExpExecArray } => x.m !== null)
    .map(({ r, m }) => ({ r, value: m[1], local: m[2] === "true", param: m[1] === "?" ? r.params[0] : null }));

  const before = setConfigs.filter((s) => s.r.pos < lock.pos);
  const after = setConfigs.filter((s) => s.r.pos > lock.pos);
  const sets = before.filter((s) => s.param === null);
  const restoresBefore = before.filter((s) => s.param !== null);

  // Lectura del valor previo, en la función del FOR UPDATE: inline o mediante
  // una llamada a la función que contiene el current_setting.
  const fnOf = (n: ts.Node): ts.Node | null => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p;
    return null;
  };
  const lockFn = fnOf(lock.node);
  const readerNames = new Set<string>();
  for (const r of reads) {
    const f = fnOf(r.node);
    if (f && f !== lockFn && ts.isFunctionDeclaration(f) && f.name) readerNames.add(f.name.text);
  }
  const readSites: number[] = reads.filter((r) => fnOf(r.node) === lockFn).map((r) => r.pos);
  if (lockFn) for (const c of calls(lockFn)) if (readerNames.has(calleeName(c) ?? "")) readSites.push(c.getStart(ctx.sf));
  readSites.sort((a, b) => a - b);
  if (readSites.length === 0) add(ctx, "TIMEOUT_READ_MISSING", null, "no se lee current_setting('lock_timeout') antes de modificarlo");
  else if (sets.length > 0 && readSites[0] > sets[0].r.pos) add(ctx, "READ_AFTER_SET", null, "current_setting se lee después del set");
  if (sets.length === 0) add(ctx, "TIMEOUT_SET_MISSING", null, "no se fija lock_timeout antes del FOR UPDATE");
  if (sets.length > 1) add(ctx, "TIMEOUT_SET_DUPLICATE", sets[1].r.node, "lock_timeout fijado más de una vez antes del FOR UPDATE");
  for (const s of sets) {
    if (s.value !== "'3000ms'") add(ctx, "TIMEOUT_NOT_3000", s.r.node, `lock_timeout ${s.value} distinto de '3000ms'`);
    if (!s.local) add(ctx, "TIMEOUT_NOT_LOCAL", s.r.node, "lock_timeout no local a la transacción (is_local = false)");
  }
  for (const s of restoresBefore) add(ctx, "RESTORE_BEFORE_LOCK", s.r.node, "la restauración ocurre antes del FOR UPDATE");

  const restores = after.filter((s) => s.param !== null && ts.isIdentifier(unwrap((s.r.node.template as ts.TemplateExpression).templateSpans[0].expression)));
  for (const s of after.filter((x) => !restores.includes(x))) add(ctx, "RESTORE_FIXED", s.r.node, `restauración con valor fijo ${s.param ?? s.value}`);
  if (after.length === 0 && restoresBefore.length === 0) add(ctx, "RESTORE_MISSING", null, "no se restaura el lock_timeout previo después del FOR UPDATE");
  for (const s of restores) if (!s.local) add(ctx, "RESTORE_NOT_LOCAL", s.r.node, "restauración no local a la transacción");

  // NotFound sólo después de restaurar.
  const restoreAt = restores[0]?.r.pos;
  if (restoreAt !== undefined) {
    forEachNode(ctx.sf, (n) => {
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "NotFoundError" && n.getStart(ctx.sf) < restoreAt) {
        add(ctx, "NOTFOUND_BEFORE_RESTORE", n, "NotFoundError antes de restaurar el lock_timeout");
      }
    });
  }

  // Traducción exclusiva de P2010 / 55P03 alrededor del FOR UPDATE.
  let tryStmt: ts.TryStatement | null = null;
  for (let p: ts.Node = lock.node.parent; p; p = p.parent) {
    if (ts.isBlock(p) && ts.isTryStatement(p.parent) && p.parent.tryBlock === p) {
      tryStmt = p.parent;
      break;
    }
    if (ts.isFunctionLike(p)) break;
  }
  const rawIn = (node: ts.Node) => raws.filter((r) => r.pos >= node.getStart(ctx.sf) && r.pos < node.getEnd());
  const busyIn = (node: ts.Node) => {
    let n = 0;
    forEachNode(node, (x) => {
      if (ts.isNewExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === "PeriodBusyError") n++;
    });
    return n;
  };
  if (!tryStmt || !tryStmt.catchClause) add(ctx, "BUSY_TRANSLATION", lock.node, "el FOR UPDATE no está dentro de try/catch");
  else {
    if (rawIn(tryStmt.tryBlock).length !== 1) add(ctx, "BUSY_TRANSLATION", tryStmt, "el try del FOR UPDATE contiene otras consultas");
    if (rawIn(tryStmt.catchClause.block).length !== 0) add(ctx, "BUSY_TRANSLATION", tryStmt.catchClause, "el catch del FOR UPDATE consulta la transacción abortada");
    if (busyIn(tryStmt.catchClause.block) !== 1 || busyIn(ctx.sf) !== 1) add(ctx, "BUSY_TRANSLATION", tryStmt.catchClause, "PeriodBusyError debe construirse sólo en el catch del FOR UPDATE");
    if (tryStmt.finallyBlock) add(ctx, "BUSY_TRANSLATION", tryStmt.finallyBlock, "finally no inventariado alrededor del FOR UPDATE");
  }
  const src = ctx.sf.getFullText();
  if (!/const LOCK_NOT_AVAILABLE = "55P03";/.test(src) || !/err\.code === "P2010"/.test(src) || !/err\.meta\?\.code === LOCK_NOT_AVAILABLE/.test(src)) {
    add(ctx, "BUSY_TRANSLATION", null, "la traducción no reconoce exactamente P2010 con meta.code 55P03");
  }
}

// ── handlers ───────────────────────────────────────────────────────────────

/** `export const METHOD = withApiAuthz(...)` -> nodo del handler. */
function findHandlers(sf: ts.SourceFile): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st) || !st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && HANDLER_METHODS.has(d.name.text) && d.initializer) out.set(d.name.text, d.initializer);
    }
  }
  return out;
}

const within = (sf: ts.SourceFile, n: ts.Node, scope: ts.Node) => n.getStart(sf) >= scope.getStart(sf) && n.getEnd() <= scope.getEnd();

function writesIn(ctx: Ctx, scope: ts.Node): ts.CallExpression[] {
  return [...calls(scope)].filter((c) => isWriteCall(ctx, c));
}

/** `$transaction` de un handler (en orden de aparición). */
const txCallsOf = (handler: ts.Node) => [...calls(handler)].filter((c) => memberName(unwrap(c.expression)) === "$transaction");

/**
 * Opciones de la transacción de un handler inventariado: exactamente
 * `{ maxWait: 5000, timeout: 10000 }`, como objeto literal con valores
 * numéricos literales (sin identificadores, expresiones, spread ni claves
 * calculadas, repetidas o ajenas).
 */
function checkHandlerTxOptions(ctx: Ctx, method: string, call: ts.CallExpression): void {
  if (call.arguments.length > 2) return add(ctx, "TX_OPTIONS_UNEVALUABLE", call.arguments[2], `${method}: $transaction con argumentos no inventariados`);
  const opts = call.arguments[1];
  if (!opts) return add(ctx, "TX_OPTIONS_MISSING", call, `${method}: $transaction sin { maxWait: 5000, timeout: 10000 }`);
  if (!ts.isObjectLiteralExpression(opts)) return add(ctx, "TX_OPTIONS_UNEVALUABLE", opts, `${method}: opciones de $transaction no literales: ${text(ctx.sf, opts)}`);

  const seen = new Map<string, ts.ObjectLiteralElementLike[]>();
  for (const p of opts.properties) {
    if (ts.isSpreadAssignment(p)) {
      add(ctx, "TX_OPTIONS_UNEVALUABLE", p, `${method}: spread en las opciones de $transaction: ${text(ctx.sf, p)}`);
      continue;
    }
    const name = p.name && (ts.isIdentifier(p.name) || isStringLit(p.name)) ? p.name.text : null;
    if (name === null) {
      add(ctx, "TX_OPTIONS_UNEVALUABLE", p, `${method}: clave no evaluable en las opciones de $transaction: ${text(ctx.sf, p)}`);
      continue;
    }
    if (!HANDLER_TX_OPTIONS.some((o) => o.key === name)) {
      add(ctx, "TX_OPTIONS_UNEXPECTED", p, `${method}: opción de $transaction no inventariada: ${name}`);
      continue;
    }
    seen.set(name, [...(seen.get(name) ?? []), p]);
  }

  for (const o of HANDLER_TX_OPTIONS) {
    const props = seen.get(o.key) ?? [];
    if (props.length === 0) {
      add(ctx, o.missing, opts, `${method}: falta ${o.key}: ${o.literal} en las opciones de $transaction`);
      continue;
    }
    if (props.length > 1) {
      add(ctx, o.duplicate, props[1], `${method}: ${o.key} repetido en las opciones de $transaction`);
      continue;
    }
    const p = props[0];
    if (!ts.isPropertyAssignment(p)) {
      add(ctx, o.unevaluable, p, `${method}: ${o.key} no evaluable: ${text(ctx.sf, p)}`);
      continue;
    }
    const v = p.initializer;
    const isNumber =
      ts.isNumericLiteral(v) ||
      (ts.isPrefixUnaryExpression(v) && v.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(v.operand));
    if (!isNumber) add(ctx, o.unevaluable, v, `${method}: ${o.key} no es un literal numérico: ${text(ctx.sf, v)}`);
    else if (text(ctx.sf, v) !== o.literal) add(ctx, o.invalid, v, `${method}: ${o.key} ${text(ctx.sf, v)} (se exige exactamente ${o.literal})`);
  }
}

function checkHandler(ctx: Ctx, method: string, handler: ts.Node): void {
  const { sf } = ctx;
  checkClientAliases(ctx, handler);

  const txCalls = txCallsOf(handler);
  if (txCalls.length === 0) return add(ctx, "HANDLER_NO_TX", handler, `${method}: sin transacción interactiva`);
  if (txCalls.length > 1) add(ctx, "HANDLER_MULTI_TX", txCalls[1], `${method}: más de una transacción`);
  checkHandlerTxOptions(ctx, method, txCalls[0]);
  const cb = txCalls[0].arguments[0] ? unwrap(txCalls[0].arguments[0]) : null;
  if (!cb || !isFunctionLike(cb)) return; // TX_BATCH / TX_NOT_INTERACTIVE (global)
  const fn = cb as ts.ArrowFunction | ts.FunctionExpression;
  const txParam = fn.parameters[0] && ts.isIdentifier(fn.parameters[0].name) ? fn.parameters[0].name.text : null;

  // Primera operación awaited de la transacción.
  const awaits: ts.AwaitExpression[] = [];
  forEachNode(fn.body, (n) => {
    if (ts.isAwaitExpression(n)) awaits.push(n);
  });
  awaits.sort((a, b) => a.getStart(sf) - b.getStart(sf));
  const firstExpr = awaits[0] ? unwrap(awaits[0].expression) : null;
  const firstIsLock = !!firstExpr && ts.isCallExpression(firstExpr) && calleeName(firstExpr) === "lockPeriodForWrite";
  if (!firstIsLock) add(ctx, "LOCK_NOT_FIRST", awaits[0] ?? fn, `${method}: lockPeriodForWrite no es la primera operación awaited de la transacción`);
  else {
    const args = (firstExpr as ts.CallExpression).arguments;
    const okArgs =
      args.length === 3 &&
      ts.isIdentifier(args[0]) && args[0].text === txParam &&
      ts.isIdentifier(args[2]) && args[2].text === "organizationId";
    if (!okArgs) add(ctx, "LOCK_ARGS", firstExpr, `${method}: lockPeriodForWrite(tx, <período>, organizationId) con otros argumentos`);
  }

  const lockCalls = [...calls(handler)].filter((c) => calleeName(c) === "lockPeriodForWrite");
  if (lockCalls.length !== 1) add(ctx, "LOCK_COUNT", lockCalls[1] ?? handler, `${method}: ${lockCalls.length} llamadas a lockPeriodForWrite`);
  const lockAt = firstIsLock ? firstExpr!.getStart(sf) : (lockCalls[0]?.getStart(sf) ?? Number.POSITIVE_INFINITY);

  // Nada dependiente antes del bloqueo del Period.
  for (const c of calls(handler)) {
    if (c.getStart(sf) >= lockAt) continue;
    const name = calleeName(c);
    const mc = modelCall(ctx, c);
    let kind: string | null = null;
    if (isWriteCall(ctx, c)) kind = "escritura";
    else if (name === "recordAudit") kind = "recordAudit";
    else if (name === "lockInvoiceForUpdate" || name === "lockedRowWithLines") kind = "lock de Invoice";
    else if (name === TAX_RECORD_LOCK_FN) kind = "lock de TaxRecord";
    else if (name === "assertTurivaIncludedUnderLock" || mc?.model === "periodVatSettings") kind = "lectura TurIVA";
    else if (mc?.op === "count") kind = "conteo";
    if (kind) add(ctx, "BEFORE_LOCK", c, `${method}: ${kind} antes de lockPeriodForWrite: ${text(sf, c.expression)}`);
  }

  const writes = writesIn(ctx, handler);
  if (writes.length === 0) add(ctx, "NO_WRITES", handler, `${method}: sin escrituras (¿sobra en el inventario?)`);
  for (const w of writes) {
    if (!within(sf, w, fn.body) && w.getStart(sf) >= lockAt) add(ctx, "WRITE_OUTSIDE_TX", w, `${method}: escritura fuera de la transacción`);
  }

  // Edición/baja de TaxRecord: la fila se bloquea (después del Period, ya
  // controlado por BEFORE_LOCK) antes de escribirla y antes del AuditLog.
  const rowWrites = writes.filter((w) => {
    const mc = modelCall(ctx, w);
    return mc?.model === "taxRecord" && TAX_RECORD_ROW_WRITE_OPS.has(mc.op);
  });
  const rowLocks = [...calls(handler)].filter((c) => calleeName(c) === TAX_RECORD_LOCK_FN);
  if (rowWrites.length > 0 && rowLocks.length === 0) {
    add(ctx, "TAX_RECORD_LOCK_MISSING", rowWrites[0], `${method}: ${text(sf, rowWrites[0].expression)} sin ${TAX_RECORD_LOCK_FN}`);
  }
  if (rowLocks.length > 0) {
    const rowLockAt = rowLocks[0].getStart(sf);
    for (const c of calls(handler)) {
      const at = c.getStart(sf);
      if (at < lockAt || at >= rowLockAt) continue;
      if (rowWrites.includes(c) || calleeName(c) === "recordAudit") {
        add(ctx, "TAX_RECORD_WRITE_BEFORE_LOCK", c, `${method}: ${text(sf, c.expression)} antes de ${TAX_RECORD_LOCK_FN}`);
      }
    }
  }
}

// ── entrada ────────────────────────────────────────────────────────────────

/**
 * Violaciones de un archivo. `methods`: handlers inventariados del archivo
 * (undefined = el archivo no puede escribir el contenido del período).
 */
export function analyzeSource(file: string, src: string, methods?: readonly string[]): Violation[] {
  const sf = parse(file, src);
  const ctx: Ctx = { file, sf, v: [], modelAliases: new Map() };
  collectModelAliases(ctx);

  const handlers = findHandlers(sf);
  // Transacción (la primera) de cada handler inventariado presente.
  const handlerTx = new Set<ts.CallExpression>();
  for (const m of methods ?? []) {
    const h = handlers.get(m);
    const tx = h ? txCallsOf(h)[0] : undefined;
    if (tx) handlerTx.add(tx);
  }

  const raws = collectRaw(ctx);
  checkRawInventory(ctx, raws);
  checkAccessAndAliases(ctx);
  checkNestedWrites(ctx);
  checkTransactions(ctx, handlerTx);
  checkBusyOutsideHelper(ctx);
  if (file === "lib/period-lock.ts") checkLockHelper(ctx, raws);
  if (file === TAX_RECORD_LOCK_FILE) checkTaxRecordLockHelper(ctx);

  // lockTaxRecordForUpdate sólo dentro de handlers inventariados.
  if (file !== TAX_RECORD_LOCK_FILE) {
    for (const c of calls(sf)) {
      if (calleeName(c) !== TAX_RECORD_LOCK_FN) continue;
      const owner = [...handlers.entries()].find(([, h]) => within(sf, c, h));
      if (!owner || !methods?.includes(owner[0])) {
        add(ctx, "TAX_RECORD_LOCK_OUTSIDE_INVENTORY", c, `${TAX_RECORD_LOCK_FN} fuera de un handler inventariado`);
      }
    }
  }

  const writes = writesIn(ctx, sf);
  if (!methods) {
    for (const w of writes) add(ctx, "WRITE_OUTSIDE_INVENTORY", w, `escritura del contenido del período fuera del inventario: ${text(sf, w.expression)}`);
    return ctx.v;
  }
  for (const w of writes) {
    const owner = [...handlers.entries()].find(([, h]) => within(sf, w, h));
    if (!owner) add(ctx, "WRITE_IN_PRELUDE", w, `escritura fuera de los handlers: ${text(sf, w.expression)}`);
    else if (!methods.includes(owner[0])) add(ctx, "WRITE_IN_UNLISTED_HANDLER", w, `${owner[0]} escribe y no está inventariado`);
  }
  for (const m of methods) {
    const h = handlers.get(m);
    if (!h) add(ctx, "HANDLER_MISSING", null, `falta el handler inventariado ${m}`);
    else checkHandler(ctx, m, h);
  }
  return ctx.v;
}

/** Códigos (ordenados, sin repetir) de las violaciones. */
export const codesOf = (v: Violation[]) => [...new Set(v.map((x) => x.code))].sort();
