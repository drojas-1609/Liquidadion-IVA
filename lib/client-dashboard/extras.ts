import type { PrismaClient } from "@prisma/client";
import { computeLiquidation } from "@/lib/liquidation-calc";
import { loadPeriodLiquidationInput } from "@/lib/liquidation-totals";
import { upcomingDueDates, type DueDate, type DueObligation } from "@/lib/calendar/arca-due-dates";

/**
 * Paneles del resumen del cliente (todo lectura, ya dentro del control de
 * acceso de la página). Cada panel se carga por separado: si uno falla se
 * muestra «no disponible» y el resto del resumen sigue funcionando.
 */

type Db = PrismaClient;

export interface Panel<T> {
    ok: boolean;
    data: T | null;
}

async function safe<T>(name: string, fn: () => Promise<T>): Promise<Panel<T>> {
    try {
        return { ok: true, data: await fn() };
    } catch (err) {
        console.error(`[resumen-cliente] panel ${name}:`, err instanceof Error ? err.message : err);
        return { ok: false, data: null };
    }
}

export interface PositionPanel {
    periodId: string;
    periodLabel: string;
    /** Saldo de IVA: positivo a pagar, negativo a favor (libre disponibilidad). */
    ivaPayable: string;
    ivaTechnicalInFavor: string;
    /** IIBB: positivo a favor de la DGR. */
    iibbPayable: string;
}

export interface BackupPanel {
    done: number;
    pending: number;
    error: number;
    recent: { id: string; fileName: string; status: string; at: string; link: string | null }[];
}

export interface ActivityItem {
    id: string;
    action: string;
    at: string;
}

export interface Alert {
    level: "high" | "medium";
    text: string;
    href?: string;
}

/** Hoy en Argentina (UTC-3, sin horario de verano) como fecha UTC a medianoche. */
export function todayInArgentina(now = new Date()): Date {
    const ar = new Date(now.getTime() - 3 * 3_600_000);
    return new Date(Date.UTC(ar.getUTCFullYear(), ar.getUTCMonth(), ar.getUTCDate()));
}

export async function loadPosition(db: Db, scope: { organizationId: string; periodId: string; periodLabel: string }) {
    return safe<PositionPanel | null>("posición", async () => {
        const input = await loadPeriodLiquidationInput(db, scope);
        if (!input) return null;
        const r = computeLiquidation(input);
        return {
            periodId: scope.periodId,
            periodLabel: scope.periodLabel,
            ivaPayable: r.iva.payable.toFixed(2),
            ivaTechnicalInFavor: r.iva.technicalBalanceInFavor.toFixed(2),
            iibbPayable: r.iibb.payable.toFixed(2),
        };
    });
}

export async function loadBackups(db: Db, scope: { organizationId: string; clientId: string }) {
    return safe<BackupPanel>("respaldos", async () => {
        const where = { organizationId: scope.organizationId, clientId: scope.clientId };
        const [groups, recent] = await Promise.all([
            db.documentBackup.groupBy({ by: ["status"], where, _count: { _all: true } }),
            db.documentBackup.findMany({
                where,
                orderBy: { createdAt: "desc" },
                take: 4,
                select: { id: true, fileName: true, status: true, createdAt: true, driveLink: true },
            }),
        ]);
        const n = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
        return {
            done: n("DONE"),
            pending: n("PENDING"),
            error: n("ERROR"),
            recent: recent.map((b) => ({ id: b.id, fileName: b.fileName, status: b.status, at: b.createdAt.toISOString(), link: b.driveLink })),
        };
    });
}

export async function loadActivity(db: Db, scope: { organizationId: string; clientId: string }) {
    return safe<ActivityItem[]>("actividad", async () => {
        const rows = await db.auditLog.findMany({
            where: {
                organizationId: scope.organizationId,
                OR: [{ targetId: scope.clientId }, { metadata: { path: ["clientId"], equals: scope.clientId } }],
            },
            orderBy: { createdAt: "desc" },
            take: 8,
            select: { id: true, action: true, createdAt: true },
        });
        return rows.map((r) => ({ id: r.id, action: r.action, at: r.createdAt.toISOString() }));
    });
}

export async function loadEmployerFlag(db: Db, scope: { organizationId: string; clientId: string }) {
    return safe<boolean>("empleador", async () => (await db.payrollF931.count({ where: { organizationId: scope.organizationId, clientId: scope.clientId } })) > 0);
}

export async function loadChartFlag(db: Db, scope: { organizationId: string; clientId: string }) {
    return safe<boolean>("plan", async () => (await db.chartAccount.count({ where: { organizationId: scope.organizationId, clientId: scope.clientId } })) > 0);
}

export async function loadDriveFlag(db: Db, organizationId: string) {
    return safe<boolean>("drive", async () => (await db.driveConnection.count({ where: { organizationId } })) > 0);
}

/** Obligaciones con vencimiento calculado: IVA si es responsable inscripto; F.931 si es empleador. */
export function obligationsFor(client: { condition: string }, isEmployer: boolean): DueObligation[] {
    const out: DueObligation[] = [];
    if (/responsable\s+inscripto/i.test(client.condition)) out.push("IVA");
    if (isEmployer) out.push("SUSS");
    return out;
}

export function dueDatesFor(client: { cuit: string; condition: string }, isEmployer: boolean, today: Date): DueDate[] {
    return upcomingDueDates({ cuit: client.cuit, obligations: obligationsFor(client, isEmployer), from: today, days: 45 });
}

const LABEL_ACTION: Record<string, string> = {
    "client.create": "Alta del cliente",
    "client.update": "Datos del cliente modificados",
    "client.accounting_profile": "Perfil contable actualizado",
    "chart.account_create": "Cuenta agregada al plan",
    "chart.account_update": "Cuenta del plan modificada",
    "chart.model_apply": "Plan de cuentas modelo aplicado",
    "invoice.update": "Comprobante modificado",
    "invoice.delete": "Comprobante eliminado",
    "invoice.tributes_sync": "Tributos de comprobantes sincronizados",
    "period.update": "Período modificado",
    "period.vat_position_change": "Datos de la DDJJ de IVA actualizados",
    "period.iibb_position_change": "Datos de la DDJJ de IIBB actualizados",
    "period.vat_settings_change": "Configuración de IVA del período actualizada",
    "taxrecord.import": "Retenciones y percepciones importadas",
    "taxrecord.iibb_import": "Retenciones de IIBB importadas",
    "taxrecord.update": "Retención o percepción modificada",
    "taxrecord.delete": "Retención o percepción eliminada",
    "iibb.f5680.export": "DDJJ de IIBB exportada",
    "vat.package.export": "Paquete de IVA exportado",
    "period.create": "Período creado",
    "period.close": "Período cerrado",
    "period.reopen": "Período reabierto",
    "period.delete": "Período eliminado",
    "invoice.create": "Comprobante cargado",
    "invoice.import": "Comprobantes importados",
    "invoice.import.failed": "Importación con error",
    "taxrecord.create": "Retención o percepción cargada",
    "liquidation.export": "Liquidación exportada",
    "journal.entry_generate": "Asiento generado",
    "journal.tax_payment": "Pago de impuesto registrado",
    "journal.entry_delete": "Asiento anulado",
    "drive.backup_upload": "Comprobante respaldado en Drive",
    "payroll.f931_save": "F.931 grabado",
    "payroll.zone_update": "Zona del Anexo I actualizada",
    "payroll.union_slip": "Boleta sindical registrada",
    "payroll.union_slip_delete": "Boleta sindical eliminada",
};

/** Texto legible de una acción de auditoría (o la clave, si no tiene etiqueta). */
export function activityLabel(action: string): string {
    return LABEL_ACTION[action] ?? action.replace(/[._]/g, " ");
}

/** Alertas internas del cliente (no reemplazan a las de ARCA). */
export function buildAlerts(opts: {
    clientId: string;
    today: Date;
    mipymeValidUntil: Date | null;
    mipymeCategory: string | null;
    hasChart: boolean | null;
    isEmployer: boolean | null;
    payrollZoneCode: number | null;
    backupErrors: number | null;
    openPeriods: { id: string; label: string; year: number; month: number }[];
}): Alert[] {
    const c = `/client/${opts.clientId}`;
    const out: Alert[] = [];
    if (opts.mipymeCategory && opts.mipymeValidUntil) {
        const days = Math.round((opts.mipymeValidUntil.getTime() - opts.today.getTime()) / 86_400_000);
        if (days < 0) out.push({ level: "high", text: `Certificado MiPyME vencido el ${fmtDate(opts.mipymeValidUntil)}.`, href: `${c}/accounts` });
        else if (days <= 30) out.push({ level: days <= 7 ? "high" : "medium", text: `Certificado MiPyME vence el ${fmtDate(opts.mipymeValidUntil)} (en ${days} días).`, href: `${c}/accounts` });
    }
    if (opts.hasChart === false) out.push({ level: "medium", text: "Sin plan de cuentas: no se pueden generar asientos.", href: `${c}/accounts` });
    if (opts.isEmployer && opts.payrollZoneCode == null) out.push({ level: "medium", text: "Empleador sin zona del Anexo I (Ley 27.541).", href: `${c}/payroll` });
    if (opts.backupErrors) out.push({ level: "medium", text: `${opts.backupErrors} comprobante(s) sin respaldar en Drive.`, href: `${c}/backups` });
    // Períodos abiertos de dos o más meses atrás (el del mes anterior es el que se está liquidando).
    const cutoff = opts.today.getUTCFullYear() * 12 + opts.today.getUTCMonth() - 1;
    for (const p of opts.openPeriods) {
        if (p.year * 12 + (p.month - 1) < cutoff) out.push({ level: "medium", text: `Período ${p.label} sigue abierto.`, href: `${c}/period/${p.id}` });
    }
    return out;
}

export function fmtDate(d: Date | string): string {
    const s = typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);
    const [y, m, day] = s.split("-");
    return `${day}/${m}/${y}`;
}
