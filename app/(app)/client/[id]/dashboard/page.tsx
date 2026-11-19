import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requireClientAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_READ, ROLES_CREATE, ROLES_CLIENT_MANAGE, ROLES_DELETE, roleAllows } from "@/lib/auth/roles";
import { formatPeriodLabel } from "@/lib/period";
import { periodStatusLabel } from "@/lib/period-status";
import { NotFoundError } from "@/lib/auth/errors";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { AccessNotice } from "@/app/_components/access-notice";
import { formatMoney } from "@/lib/format";
import { annexIZone } from "@/lib/payroll/annex-i";
import { MIPYME_LABEL } from "@/lib/accounting/profile";
import { daysUntil } from "@/lib/calendar/arca-due-dates";
import {
    activityLabel,
    buildAlerts,
    dueDatesFor,
    fmtDate,
    loadActivity,
    loadBackups,
    loadChartFlag,
    loadDriveFlag,
    loadEmployerFlag,
    loadPosition,
    todayInArgentina,
} from "@/lib/client-dashboard/extras";
import { ClientActions } from "./client-actions";

export const dynamic = "force-dynamic";


function urgency(days: number): string {
    if (days <= 0) return "Hoy";
    if (days === 1) return "Mañana";
    return `En ${days} días`;
}

export default async function ClientDashboard({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId, role, modules } = await requireClientAccess(profileId, id, ROLES_READ, {
            module: MODULES_CLIENT_DIRECTORY,
        });
        const hasIva = modules.includes("IVA");
        // Los períodos son del módulo IVA: sin él no se leen.
        const full = hasIva
            ? await prisma.client.findFirst({
                  where: { id, organizationId },
                  include: {
                      periods: { orderBy: [{ year: "desc" }, { month: "desc" }] },
                  },
              })
            : await prisma.client.findFirst({ where: { id, organizationId } }).then((c) => (c ? { ...c, periods: [] } : null));
        if (!full) throw new NotFoundError();

        // Paneles del resumen: cada uno se carga por separado y puede faltar sin romper la página.
        const scope = { organizationId, clientId: id };
        const latest = full.periods[0];
        const [position, backups, activity, employer, chart, drive] = await Promise.all([
            hasIva && latest ? loadPosition(prisma, { organizationId, periodId: latest.id, periodLabel: formatPeriodLabel(latest) }) : Promise.resolve(null),
            loadBackups(prisma, scope),
            loadActivity(prisma, scope),
            loadEmployerFlag(prisma, scope),
            loadChartFlag(prisma, scope),
            loadDriveFlag(prisma, organizationId),
        ]);
        return { client: full, role, hasIva, hasClients: modules.includes("CLIENTS"), position, backups, activity, employer, chart, drive };
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const { client, role, hasIva, hasClients, position, backups, activity, employer, chart, drive } = guard.data;
    const canEdit = hasClients && roleAllows(ROLES_CLIENT_MANAGE, role);
    const canDelete = hasClients && roleAllows(ROLES_DELETE, role);
    const canCreatePeriod = hasIva && roleAllows(ROLES_CREATE, role);

    const today = todayInArgentina();
    const c = `/client/${client.id}`;
    const isEmployer = employer.ok ? !!employer.data : false;
    const dues = dueDatesFor(client, isEmployer, today);
    const zone = client.payrollZoneCode != null ? annexIZone(client.payrollZoneCode) : null;
    const alerts = buildAlerts({
        clientId: client.id,
        today,
        mipymeValidUntil: client.mipymeValidUntil,
        mipymeCategory: client.mipymeCategory,
        hasChart: chart.ok ? !!chart.data : null,
        isEmployer: employer.ok ? !!employer.data : null,
        payrollZoneCode: client.payrollZoneCode,
        backupErrors: backups.ok && backups.data ? backups.data.error : null,
        openPeriods: client.periods
            .filter((p) => p.status === "OPEN")
            .map((p) => ({ id: p.id, label: formatPeriodLabel(p), year: p.year, month: p.month })),
    });

    return (
        <div className="container client-dashboard">
            <section className="card dash-head">
                <div className="dash-head-main">
                    <small>Cliente seleccionado</small>
                    <h1>{client.name}</h1>
                    <p>
                        CUIT {client.cuit} · {client.condition}
                    </p>
                </div>
                <ClientActions clientId={client.id} clientName={client.name} canEdit={canEdit} canDelete={canDelete} />
                <ul className="dash-chips" aria-label="Estado de la configuración">
                    <li className={chart.ok && chart.data ? "is-ok" : "is-warn"}>
                        <Link href={`${c}/accounts`}>{chart.ok && chart.data ? "Plan de cuentas" : "Sin plan de cuentas"}</Link>
                    </li>
                    <li className={client.mipymeCategory ? "is-ok" : "is-off"}>
                        <Link href={`${c}/accounts`}>
                            {client.mipymeCategory
                                ? `MiPyME ${MIPYME_LABEL[client.mipymeCategory as keyof typeof MIPYME_LABEL] ?? client.mipymeCategory}${client.mipymeValidUntil ? ` · hasta ${fmtDate(client.mipymeValidUntil)}` : ""}`
                                : "Sin certificado MiPyME"}
                        </Link>
                    </li>
                    {isEmployer && (
                        <li className={zone ? "is-ok" : "is-warn"}>
                            <Link href={`${c}/payroll`}>{zone ? `Zona ${zone.code} · ${zone.percent.replace(".", ",")} %` : "Sin zona Anexo I"}</Link>
                        </li>
                    )}
                    <li className={drive.ok && drive.data ? "is-ok" : "is-off"}>
                        <Link href={`${c}/backups`}>{drive.ok && drive.data ? "Respaldo en Drive" : "Drive sin conectar"}</Link>
                    </li>
                </ul>
            </section>

            <div className="dash-grid">
                {hasIva && (
                    <section className="card dash-panel">
                        <header>
                            <h2>Posición del último período</h2>
                            <p>{position?.ok && position.data ? `Período ${position.data.periodLabel}` : "Liquidación de IVA e IIBB"}</p>
                        </header>
                        {!client.periods.length ? (
                            <p className="dash-empty">Todavía no hay períodos.</p>
                        ) : !position?.ok ? (
                            <p className="dash-empty">No se pudo calcular la posición. Abrí la liquidación para ver el detalle.</p>
                        ) : position.data ? (
                            <dl className="dash-figures">
                                <div>
                                    <dt>IVA</dt>
                                    <dd className={Number(position.data.ivaPayable) > 0 ? "is-pay" : "is-favor"}>
                                        $ {formatMoney(Math.abs(Number(position.data.ivaPayable)).toFixed(2))}
                                        <small>{Number(position.data.ivaPayable) > 0 ? "a pagar" : "a favor (libre disponibilidad)"}</small>
                                    </dd>
                                </div>
                                {Number(position.data.ivaTechnicalInFavor) > 0 && (
                                    <div>
                                        <dt>Saldo técnico a favor</dt>
                                        <dd className="is-favor">$ {formatMoney(position.data.ivaTechnicalInFavor)}</dd>
                                    </div>
                                )}
                                <div>
                                    <dt>Ingresos Brutos</dt>
                                    <dd className={Number(position.data.iibbPayable) > 0 ? "is-pay" : "is-favor"}>
                                        $ {formatMoney(Math.abs(Number(position.data.iibbPayable)).toFixed(2))}
                                        <small>{Number(position.data.iibbPayable) > 0 ? "a pagar" : "a favor"}</small>
                                    </dd>
                                </div>
                            </dl>
                        ) : null}
                        {position?.ok && position.data && (
                            <footer>
                                <Link href={`${c}/period/${position.data.periodId}/liquidation`}>Ver liquidación completa →</Link>
                            </footer>
                        )}
                    </section>
                )}

                <section className="card dash-panel">
                    <header>
                        <h2>Próximos vencimientos</h2>
                        <p>Próximos 45 días, por terminación de CUIT</p>
                    </header>
                    {dues.length === 0 ? (
                        <p className="dash-empty">Sin vencimientos calculados para este cliente.</p>
                    ) : (
                        <ul className="dash-list">
                            {dues.map((d) => {
                                const n = daysUntil(d.date, today);
                                return (
                                    <li key={`${d.obligation}-${d.date}`}>
                                        <span className="dash-date">
                                            <b>{d.date.slice(8, 10)}</b>
                                            <small>{["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"][Number(d.date.slice(5, 7)) - 1]}</small>
                                        </span>
                                        <span className="dash-main">
                                            <strong>
                                                {d.label} {d.period}
                                            </strong>
                                            <small>{d.detail}{d.adjusted ? "" : " · sin feriados cargados"}</small>
                                        </span>
                                        <span className={n <= 2 ? "dash-tag is-high" : n <= 7 ? "dash-tag is-medium" : "dash-tag"}>{urgency(n)}</span>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    <footer className="dash-note">
                        Calculados con la agenda de la RG 4172 y los feriados nacionales. El calendario que publica ARCA cada mes es el que manda.
                    </footer>
                </section>

                <section className="card dash-panel">
                    <header>
                        <h2>Alertas</h2>
                        <p>Pendientes detectados en el sistema</p>
                    </header>
                    {alerts.length === 0 ? (
                        <p className="dash-empty">Sin alertas.</p>
                    ) : (
                        <ul className="dash-list">
                            {alerts.map((a) => (
                                <li key={a.text}>
                                    <span className={a.level === "high" ? "dash-dot is-high" : "dash-dot is-medium"} aria-hidden="true" />
                                    <span className="dash-main">{a.href ? <Link href={a.href}>{a.text}</Link> : a.text}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                {hasIva && (
                    <section className="card dash-panel">
                        <header className="dash-panel-head">
                            <div>
                                <h2>Períodos fiscales</h2>
                                <p>{client.periods.length} registrado(s)</p>
                            </div>
                            {canCreatePeriod && (
                                <Link href={`${c}/period/new`} className="btn btn-primary btn-sm">
                                    Nuevo período
                                </Link>
                            )}
                        </header>
                        {client.periods.length === 0 ? (
                            <p className="dash-empty">No hay períodos registrados.</p>
                        ) : (
                            <ul className="dash-list">
                                {client.periods.slice(0, 6).map((period) => (
                                    <li key={period.id}>
                                        <span className="dash-main">
                                            <strong>{formatPeriodLabel(period)}</strong>
                                        </span>
                                        <span className={period.status === "OPEN" ? "dash-tag is-medium" : "dash-tag is-ok"} data-period-status={period.status}>
                                            {periodStatusLabel(period.status)}
                                        </span>
                                        <Link href={`${c}/period/${period.id}`}>Gestionar</Link>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                )}

                <section className="card dash-panel">
                    <header>
                        <h2>Respaldos en Drive</h2>
                        <p>Comprobantes guardados del cliente</p>
                    </header>
                    {!backups.ok || !backups.data ? (
                        <p className="dash-empty">No disponible.</p>
                    ) : (
                        <>
                            <p className="dash-counts">
                                <span className="is-ok">{backups.data.done} en Drive</span>
                                <span className="is-medium">{backups.data.pending} pendientes</span>
                                <span className="is-high">{backups.data.error} con error</span>
                            </p>
                            <ul className="dash-list">
                                {backups.data.recent.map((b) => (
                                    <li key={b.id}>
                                        <span className="dash-main">
                                            {b.link ? (
                                                <a href={b.link} target="_blank" rel="noreferrer">
                                                    {b.fileName}
                                                </a>
                                            ) : (
                                                b.fileName
                                            )}
                                            <small>{fmtDate(b.at)}</small>
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                    <footer>
                        <Link href={`${c}/backups`}>Ver respaldos →</Link>
                    </footer>
                </section>

                <section className="card dash-panel">
                    <header>
                        <h2>Actividad reciente</h2>
                        <p>Últimos movimientos registrados</p>
                    </header>
                    {!activity.ok || !activity.data ? (
                        <p className="dash-empty">No disponible.</p>
                    ) : activity.data.length === 0 ? (
                        <p className="dash-empty">Sin movimientos todavía.</p>
                    ) : (
                        <ul className="dash-list">
                            {activity.data.map((a) => (
                                <li key={a.id}>
                                    <span className="dash-main">
                                        {activityLabel(a.action)}
                                        <small>
                                            {new Date(a.at).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                                        </small>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </div>
        </div>
    );
}
