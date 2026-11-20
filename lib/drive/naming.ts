/**
 * Respaldo de comprobantes en Google Drive (Fase C4): nombres y carpetas.
 * Funciones puras. Estructura dentro de la carpeta raíz «DERO COMPANY GESTIÓN»:
 *
 *   <RAZÓN SOCIAL - CUIT>/IVA/<AAAA>/<AAAA MM>/<VENTAS | COMPRAS | RETENCIONES Y PERCEPCIONES | DDJJ Y PAGOS>
 *   <RAZÓN SOCIAL - CUIT>/IIBB/<AAAA>/<AAAA MM>/<RETENCIONES Y PERCEPCIONES | DDJJ Y PAGOS>
 *   <RAZÓN SOCIAL - CUIT>/BANCOS/<BANCO>/<AAAA>
 *   <RAZÓN SOCIAL - CUIT>/SUELDOS/<AAAA>/<AAAA MM>
 *   <RAZÓN SOCIAL - CUIT>/CONTABILIDAD/<AAAA>
 *
 * Nombre del archivo, con el criterio que ya usa el estudio
 * («2026 10 F931 OOSHEN GROUP SAS VEP.pdf»): «AAAA MM <DESCRIPCIÓN> <RAZÓN SOCIAL>.<ext>».
 */

export const BACKUP_CATEGORIES = [
    "IVA_VENTAS",
    "IVA_COMPRAS",
    "IVA_RET_PERC",
    "IVA_DDJJ",
    "IIBB_RET_PERC",
    "IIBB_DDJJ",
    "BANCOS",
    "SUELDOS",
    "CONTABILIDAD",
    "CONSTANCIAS",
] as const;
export type BackupCategory = (typeof BACKUP_CATEGORIES)[number];

export const BACKUP_CATEGORY_LABEL: Record<BackupCategory, string> = {
    IVA_VENTAS: "IVA · Ventas",
    IVA_COMPRAS: "IVA · Compras",
    IVA_RET_PERC: "IVA · Retenciones y percepciones",
    IVA_DDJJ: "IVA · DDJJ y pagos",
    IIBB_RET_PERC: "IIBB · Retenciones y percepciones",
    IIBB_DDJJ: "IIBB · DDJJ y pagos",
    BANCOS: "Bancos",
    SUELDOS: "Sueldos",
    CONTABILIDAD: "Contabilidad",
    CONSTANCIAS: "Constancias",
};

/** Categorías que se cargan a mano desde Respaldos (la constancia entra por la ficha del cliente). */
export const MANUAL_BACKUP_CATEGORIES: readonly BackupCategory[] = BACKUP_CATEGORIES.filter((c) => c !== "CONSTANCIAS");

/** Categorías de archivo único: un archivo nuevo reemplaza al anterior en Drive (mismo nombre). */
export const REPLACE_CATEGORIES: readonly BackupCategory[] = ["CONSTANCIAS"];

/** Mayúsculas, sin caracteres que Drive o las PCs no aceptan bien, espacios simples. */
export function cleanSegment(s: string): string {
    return s
        .normalize("NFC")
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase()
        .slice(0, 120);
}

export function clientFolderName(name: string, cuit: string): string {
    return `${cleanSegment(name)} - ${cuit.replace(/\D/g, "")}`;
}

const mm = (m: number) => String(m).padStart(2, "0");

export interface BackupTarget {
    category: BackupCategory;
    client: { name: string; cuit: string };
    /** Período (obligatorio salvo BANCOS/CONTABILIDAD, que usan sólo el año). */
    month?: number | null;
    year: number;
    /** Banco o cuenta para BANCOS. */
    bank?: string | null;
    /** Descripción del archivo, p. ej. «RETENCIONES ASIP» o «LIBRO IVA DIGITAL COMPRAS». */
    description: string;
    /** Extensión del original (sin punto). */
    extension: string;
}

/** Ruta de carpetas (relativa a la raíz) donde va el archivo. */
export function backupFolderPath(t: BackupTarget): string[] {
    const client = clientFolderName(t.client.name, t.client.cuit);
    const y = String(t.year);
    const ym = t.month ? `${y} ${mm(t.month)}` : null;
    const needPeriod = () => {
        if (!ym) throw new Error(`La categoría ${t.category} necesita mes.`);
        return ym;
    };
    switch (t.category) {
        case "IVA_VENTAS": return [client, "IVA", y, needPeriod(), "VENTAS"];
        case "IVA_COMPRAS": return [client, "IVA", y, needPeriod(), "COMPRAS"];
        case "IVA_RET_PERC": return [client, "IVA", y, needPeriod(), "RETENCIONES Y PERCEPCIONES"];
        case "IVA_DDJJ": return [client, "IVA", y, needPeriod(), "DDJJ Y PAGOS"];
        case "IIBB_RET_PERC": return [client, "IIBB", y, needPeriod(), "RETENCIONES Y PERCEPCIONES"];
        case "IIBB_DDJJ": return [client, "IIBB", y, needPeriod(), "DDJJ Y PAGOS"];
        case "BANCOS": return [client, "BANCOS", cleanSegment(t.bank || "SIN BANCO"), y];
        case "SUELDOS": return [client, "SUELDOS", y, needPeriod()];
        case "CONTABILIDAD": return [client, "CONTABILIDAD", y];
        case "CONSTANCIAS": return [client, "CONSTANCIAS"];
    }
}

export function backupFileName(t: BackupTarget): string {
    const ext = t.extension.replace(/^\./, "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin";
    // Archivo único (se reemplaza): sin fecha en el nombre.
    if (t.category === "CONSTANCIAS") return `${`${cleanSegment(t.description)} ${cleanSegment(t.client.name)}`.replace(/[.\s]+$/, "")}.${ext}`;
    const when = t.month ? `${t.year} ${mm(t.month)}` : String(t.year);
    // Sin puntos finales antes de la extensión («… S. A. S..pdf» → «… S. A. S.pdf»).
    const base = `${when} ${cleanSegment(t.description)} ${cleanSegment(t.client.name)}`.replace(/[.\s]+$/, "");
    return `${base}.${ext}`;
}

/** Extensión a partir del nombre original o, si no hay, del contenido. */
export function guessExtension(originalName: string | null | undefined, bytes: Uint8Array): string {
    const m = originalName ? /\.([A-Za-z0-9]{1,8})$/.exec(originalName) : null;
    if (m) return m[1].toLowerCase();
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf";
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "xlsx";
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf) return "xls";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return "png";
    return "txt";
}

export const MIME_BY_EXT: Record<string, string> = {
    pdf: "application/pdf",
    txt: "text/plain",
    csv: "text/csv",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    zip: "application/zip",
};
export const mimeFor = (ext: string) => MIME_BY_EXT[ext.toLowerCase()] ?? "application/octet-stream";

/** Si el nombre ya existe con otro contenido: «… (2).pdf», «… (3).pdf». */
export function withSuffix(fileName: string, n: number): string {
    const i = fileName.lastIndexOf(".");
    return i > 0 ? `${fileName.slice(0, i)} (${n})${fileName.slice(i)}` : `${fileName} (${n})`;
}

/** Comillas y barras escapadas para la consulta `q` de Drive. */
export function qEscape(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
