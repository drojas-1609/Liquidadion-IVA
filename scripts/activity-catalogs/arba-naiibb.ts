/**
 * Importación del NAIIB-18 de ARBA (Provincia de Buenos Aires, jurisdicción
 * 902) desde la exportación OFICIAL que genera
 * https://www.arba.gov.ar/Informacion/InfoGeneral/Naiib18/naiib.asp?lugar=E&apartado=IIBB
 * (`GenerarExcelNaiibb.asp` → `archivos/temp/NAIIBB18_ALICUOTARIA.xls` y
 * `NAIIBB18_OTROSDATOS.xls`).
 *
 * Esos «.xls» son TEXTO separado por tabuladores en ISO-8859-1, no planillas:
 * abrirlos como Excel (o con SheetJS) cambia los datos (la coma decimal se toma
 * como separador de miles: «1,5» → 15; se pierden ceros iniciales; cambian las
 * fechas). Por eso se leen como texto y se convierte cada campo con reglas
 * explícitas que fallan ante cualquier formato no previsto.
 *
 *   npx --no-install vite-node scripts/activity-catalogs/cli.ts -- arba-naiibb \
 *     --alicuotaria NAIIBB18_ALICUOTARIA.xls --otros NAIIBB18_OTROSDATOS.xls \
 *     --consulted AAAA-MM-DD --generated AAAA-MM-DD \
 *     --out-catalog data/activity-catalogs/<id>.json \
 *     --out-correspondences data/activity-catalogs/<id>.correspondencias.json \
 *     --out-rates <directorio de evidencia>/arba-alicuotaria-normalizada.json
 *
 * Salidas, SEPARADAS a propósito:
 *  - catálogo (nomenclador provincial 902), PENDIENTE de revisión;
 *  - correspondencias publicadas por ARBA (NAIIB 99, equivalencia AFIP/CLAE,
 *    documentación tributaria): datos, nunca se aplican automáticamente;
 *  - alícuotas normalizadas: evidencia para el contraste con la ley impositiva;
 *    NO son reglas de sugerencia.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { entriesSha256, sha256Hex } from "../../lib/activity-catalog/checksum";
import { CATALOG_REVIEW_LEVELS, pendingReview } from "../../lib/activity-catalog/review";
import type { CatalogEntry, CatalogFile } from "../../lib/activity-catalog/types";
import { validateCatalogFile } from "../../lib/activity-catalog/validate";
import { parseArgs, required } from "./import";

export const ALICUOTARIA_HEADER = [
    "Codigo",
    "Descripcion",
    "Incluye",
    "Excluye",
    "ActividadVigenteDesde",
    "ActividadVigenteHasta",
    "Marca_No_Vigente",
    "id_Grupo_Act_Rs",
    "bonif_actiba",
    "PeriodoVigenteDesde",
    "PeriodoVigenteHasta",
    "TipoAlicuota",
    "TipoMinimoAlicuota",
    "MontoMinimoAlicuota",
    "Alicuota",
    "MontoInferiorAlicuota",
    "MontoSuperiorAlicuota",
    "Articulo",
    "AlicuotaSUS",
] as const;
export const OTROS_HEADER = ["Codigo", "Descripcion", "TipoDato", "CodigoActividad", "Descripcion", "FechaDesde", "FechaHasta", "Tipo", "Nombre"] as const;

export interface Tsv {
    header: string[];
    rows: string[][];
}

/** Texto tabulado ISO-8859-1 con CRLF; todas las celdas quedan como string. */
export function readTsvLatin1(bytes: Uint8Array, expectedHeader: readonly string[]): Tsv {
    const text = new TextDecoder("latin1").decode(bytes);
    const lines = text.split("\r\n").filter((l) => l !== "");
    const header = lines[0]?.split("\t") ?? [];
    if (JSON.stringify(header) !== JSON.stringify(expectedHeader)) {
        throw new Error(`encabezado inesperado: ${JSON.stringify(header)} (se esperaba ${JSON.stringify(expectedHeader)})`);
    }
    const rows = lines.slice(1).map((l, i) => {
        const cells = l.split("\t");
        // La exportación oficial termina algunas filas con un tabulador: sólo se acepta si esa celda extra está vacía.
        if (cells.length === header.length + 1 && cells[header.length] === "") cells.pop();
        if (cells.length !== header.length) throw new Error(`fila ${i + 2}: ${cells.length} columnas (se esperaban ${header.length})`);
        return cells;
    });
    return { header, rows };
}

const CODE6 = /^\d{6}$/;

/** «01/01/2018» (día/mes/año) → 2018-01-01. Otro formato: error. */
export function arbaDate(s: string): string {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
    if (!m) throw new Error(`fecha no reconocida: "${s}" (se espera DD/MM/AAAA)`);
    const iso = `${m[3]}-${m[2]}-${m[1]}`;
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) throw new Error(`fecha inválida: "${s}"`);
    return iso;
}

/** Número con coma decimal y sin separador de miles («1,5», «3000000,01», «0») → "1.5". «1E+13» y otros: error. */
export function arbaDecimal(s: string): string {
    const t = s.trim();
    const m = /^(\d+)(?:,(\d+))?$/.exec(t);
    if (!m) throw new Error(`número no reconocido: "${s}"`);
    const int = m[1].replace(/^0+(?=\d)/, "");
    const frac = (m[2] ?? "").replace(/0+$/, "");
    return frac ? `${int}.${frac}` : int;
}

/** «202601» → "2026-01". */
export function arbaPeriod(s: string): string {
    const m = /^(\d{4})(0[1-9]|1[0-2])$/.exec(s.trim());
    if (!m) throw new Error(`período no reconocido: "${s}"`);
    return `${m[1]}-${m[2]}`;
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ");

/** Una entrada por código; descripción y vigencia deben ser idénticas en todas las filas del código. */
export function arbaCatalogEntries(alic: Tsv): CatalogEntry[] {
    const ix = (h: string) => alic.header.indexOf(h);
    const byCode = new Map<string, CatalogEntry>();
    alic.rows.forEach((r, i) => {
        const code = r[ix("Codigo")];
        if (!CODE6.test(code)) throw new Error(`fila ${i + 2}: código «${code}» no tiene 6 dígitos (no se completan ceros)`);
        if (r[ix("Marca_No_Vigente")].trim() !== "") throw new Error(`fila ${i + 2}: Marca_No_Vigente con valor no previsto`);
        const to = r[ix("ActividadVigenteHasta")].trim();
        const entry: CatalogEntry = {
            code,
            description: norm(r[ix("Descripcion")]),
            reference: null,
            validFrom: arbaDate(r[ix("ActividadVigenteDesde")]),
            validTo: to ? arbaDate(to) : null,
        };
        const prev = byCode.get(code);
        if (prev && JSON.stringify(prev) !== JSON.stringify(entry)) throw new Error(`código ${code}: descripción o vigencia distinta entre filas`);
        byCode.set(code, entry);
    });
    return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export interface ArbaCorrespondence {
    code: string;
    type: "CORRESPONDENCIA NAIIB 99" | "EQUIVALENCIA AFIP" | "DOCUMENTACION TRIBUTARIA";
    /** Tal como lo publica ARBA (p. ej. códigos AFIP de 5 dígitos): no se completan ceros. */
    targetCode: string | null;
    targetDescription: string | null;
    from: string | null;
    documentType: string | null;
    documentName: string | null;
}

const TYPES = ["CORRESPONDENCIA NAIIB 99", "EQUIVALENCIA AFIP", "DOCUMENTACION TRIBUTARIA"] as const;

export function arbaCorrespondences(otros: Tsv, catalogCodes: ReadonlySet<string>): ArbaCorrespondence[] {
    return otros.rows.map((r, i) => {
        const [code, , type, target, targetDesc, from, to, docType, docName] = r;
        if (!CODE6.test(code) || !catalogCodes.has(code)) throw new Error(`fila ${i + 2}: código ${code} ausente del nomenclador`);
        if (!(TYPES as readonly string[]).includes(type)) throw new Error(`fila ${i + 2}: TipoDato no previsto «${type}»`);
        if (to.trim() !== "") throw new Error(`fila ${i + 2}: FechaHasta con valor no previsto`);
        if (target.trim() !== "" && !/^\d{5,6}$/.test(target.trim())) throw new Error(`fila ${i + 2}: CodigoActividad no previsto «${target}»`);
        return {
            code,
            type: type as ArbaCorrespondence["type"],
            targetCode: target.trim() || null,
            targetDescription: norm(targetDesc) || null,
            from: from.trim() ? arbaDate(from) : null,
            documentType: docType.trim() || null,
            documentName: docName.trim() || null,
        };
    });
}

export interface ArbaRateRow {
    code: string;
    periodFrom: string;
    periodTo: string;
    rateType: string;
    rate: string;
    minimumAmount: string;
    lowerAmount: string;
    /** null = sin tope (ARBA publica «1E+13») o «0» (sin tramo). Ver `upperRaw`. */
    upperAmount: string | null;
    upperRaw: string;
    article: string | null;
    rsGroup: string;
    bonification: boolean;
    rateSUS: string | null;
}

/** Filas alicuotarias normalizadas; las 13 sin período (actividades no gravadas en la exportación) se informan aparte. */
export function arbaRates(alic: Tsv): { rows: ArbaRateRow[]; withoutPeriod: string[] } {
    const ix = (h: string) => alic.header.indexOf(h);
    const rows: ArbaRateRow[] = [];
    const withoutPeriod: string[] = [];
    alic.rows.forEach((r, i) => {
        const code = r[ix("Codigo")];
        if (r[ix("PeriodoVigenteDesde")].trim() === "") {
            const rest = ["PeriodoVigenteHasta", "TipoAlicuota", "MontoMinimoAlicuota", "Alicuota", "MontoInferiorAlicuota", "MontoSuperiorAlicuota"].map((h) => r[ix(h)].trim());
            if (rest.some((x) => x !== "")) throw new Error(`fila ${i + 2}: sin período pero con datos alicuotarios`);
            withoutPeriod.push(code);
            return;
        }
        const upperRaw = r[ix("MontoSuperiorAlicuota")].trim();
        // Sin tope: ARBA publica «1E+13» (años anteriores), «9999999999999,99» (2026) o «0» (filas sin tramo).
        const upper = upperRaw === "1E+13" || upperRaw === "0" || upperRaw === "9999999999999,99" ? null : arbaDecimal(upperRaw);
        const sus = r[ix("AlicuotaSUS")].trim();
        const article = norm(r[ix("Articulo")]);
        rows.push({
            code,
            periodFrom: arbaPeriod(r[ix("PeriodoVigenteDesde")]),
            periodTo: arbaPeriod(r[ix("PeriodoVigenteHasta")]),
            rateType: r[ix("TipoAlicuota")].trim(),
            rate: arbaDecimal(r[ix("Alicuota")]),
            minimumAmount: arbaDecimal(r[ix("MontoMinimoAlicuota")]),
            lowerAmount: arbaDecimal(r[ix("MontoInferiorAlicuota")]),
            upperAmount: upper,
            upperRaw,
            article: article || null,
            rsGroup: r[ix("id_Grupo_Act_Rs")].trim(),
            bonification: r[ix("bonif_actiba")].trim() === "S",
            rateSUS: sus ? arbaDecimal(sus) : null,
        });
    });
    return { rows, withoutPeriod: [...new Set(withoutPeriod)].sort() };
}

export function arbaMain(argv: string[]): number {
    const a = parseArgs(argv);
    const req = (k: string) => required(a, k);
    const alicBytes = readFileSync(req("alicuotaria"));
    const otrosBytes = readFileSync(req("otros"));
    const alic = readTsvLatin1(alicBytes, ALICUOTARIA_HEADER);
    const otros = readTsvLatin1(otrosBytes, OTROS_HEADER);
    const entries = arbaCatalogEntries(alic);
    const generated = req("generated");
    const id = `arba-naiibb18-${generated}`;
    const catalog: CatalogFile = {
        manifest: {
            id,
            nomenclator: "PROVINCIAL",
            jurisdiction: "902",
            name: "NAIIB-18 (Nomenclador de Actividades IIBB, ARBA)",
            organism: "ARBA (Provincia de Buenos Aires)",
            norm: "RN ARBA 38/2017 y modif.",
            sourceUrl: "https://www.arba.gov.ar/Informacion/InfoGeneral/Naiib18/naiib.asp?lugar=E&apartado=IIBB",
            sourceFile: "NAIIBB18_ALICUOTARIA.xls",
            publishedAt: generated,
            consultedAt: req("consulted"),
            version: `NAIIB-18, exportación oficial del ${generated}`,
            validFrom: "2018-01-01",
            validTo: null,
            sourceSha256: sha256Hex(alicBytes),
            entriesSha256: entriesSha256(entries),
            entryCount: entries.length,
            supersedes: null,
            review: pendingReview(CATALOG_REVIEW_LEVELS),
        },
        entries,
    };
    const problems = validateCatalogFile(catalog);
    if (problems.length > 0) {
        console.error(`CATÁLOGO RECHAZADO:\n- ${problems.slice(0, 20).join("\n- ")}`);
        return 2;
    }
    const corr = arbaCorrespondences(otros, new Set(entries.map((e) => e.code)));
    const rates = arbaRates(alic);
    writeFileSync(req("out-catalog"), `${JSON.stringify(catalog, null, 1)}\n`, { flag: "wx" });
    const corrFile = {
        manifest: {
            catalogId: id,
            organism: "ARBA",
            sourceFile: "NAIIBB18_OTROSDATOS.xls",
            sourceSha256: sha256Hex(otrosBytes),
            consultedAt: req("consulted"),
            note: "Correspondencias publicadas por ARBA. Datos de referencia: no se aplican automáticamente ni determinan equivalencias ni alícuotas.",
            rowsSha256: sha256Hex(JSON.stringify(corr)),
        },
        rows: corr,
    };
    writeFileSync(req("out-correspondences"), `${JSON.stringify(corrFile, null, 1)}\n`, { flag: "wx" });
    writeFileSync(req("out-rates"), `${JSON.stringify({ sourceSha256: sha256Hex(alicBytes), withoutPeriod: rates.withoutPeriod, rows: rates.rows })}\n`, { flag: "wx" });
    const periods = [...new Set(rates.rows.map((r) => `${r.periodFrom}..${r.periodTo}`))].sort();
    console.log(`${entries.length} códigos; ${corr.length} correspondencias; ${rates.rows.length} filas alicuotarias (${periods.join(", ")}); ${rates.withoutPeriod.length} códigos sin período`);
    return 0;
}
