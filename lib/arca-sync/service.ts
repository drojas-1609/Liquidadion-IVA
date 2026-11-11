import prisma from "../prisma";
import { syncCredentials, syncOrigin } from "./auth";
import { Prisma, type Role } from "@prisma/client";
import { effectivePermissions, modulesAllow } from "../auth/permissions";
import { ROLES_CONFIG, ROLES_CREATE } from "../auth/roles";
import { ARCA_SYNC_SOURCES, ARCA_SYNC_TERMINAL, isScheduledDay, scheduleDate } from "./calendar";

const RETRYABLE = ["FAILED", "AUTH_REQUIRED"];
const terminal = new Set<string>(ARCA_SYNC_TERMINAL);
const sourceOrder = new Map<string, number>(ARCA_SYNC_SOURCES.map((source, index) => [source, index]));

export function connectorConfig() {
    const origin = syncOrigin();
    const token = process.env.ARCA_SYNC_CONNECTOR_TOKEN;
    return origin && token && token.length >= 32 && process.env.ARCA_SYNC_CREDENTIALS
        ? { url: new URL("/.netlify/functions/arca-download-background", origin), token } : null;
}

async function canImport(profileId: string, organizationId: string, clientId: string, roles: readonly Role[]) {
    const member = await prisma.membership.findUnique({
        where: { profileId_organizationId: { profileId, organizationId } },
        select: { id: true, status: true, role: true, clientScope: true, modules: true },
    });
    if (!member || member.status !== "ACTIVE" || !roles.includes(member.role)) return false;
    const permissions = effectivePermissions(member);
    if (!modulesAllow(permissions.modules, "IVA")) return false;
    if (permissions.clientScope === "ALL") return true;
    return Boolean(await prisma.membershipClient.findUnique({
        where: { membershipId_clientId: { membershipId: member.id, clientId } },
        select: { clientId: true },
    }));
}

export async function getSyncStatus(periodId: string, clientId: string) {
    const [schedule, latest, client] = await Promise.all([
        prisma.arcaSyncSchedule.findUnique({ where: { clientId }, select: { enabled: true, extraDays: true } }),
        prisma.arcaSyncTask.findFirst({
            where: { periodId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { runKey: true },
        }),
        prisma.client.findUnique({ where: { id: clientId }, select: { cuit: true } }),
    ]);
    const tasks = latest ? await prisma.arcaSyncTask.findMany({
        where: { periodId, runKey: latest.runKey },
        select: { source: true, status: true, downloaded: true, imported: true, duplicates: true, pending: true, errorCode: true, issues: true, updatedAt: true },
    }) : [];
    tasks.sort((a, b) => sourceOrder.get(a.source)! - sourceOrder.get(b.source)!);
    return { schedule, configured: Boolean(connectorConfig() && client && syncCredentials(client.cuit.replace(/\D/g, ""))), tasks };
}

export async function enqueueSync(periodId: string, organizationId: string, actorProfileId: string, runKey: string) {
    const period = await prisma.period.findFirst({ where: { id: periodId, organizationId }, select: { clientId: true } });
    if (!period) return;
    await prisma.arcaSyncTask.createMany({
        data: ARCA_SYNC_SOURCES.map((source) => ({ periodId, organizationId, clientId: period.clientId, actorProfileId, runKey, source })),
        skipDuplicates: true,
    });
}

export async function startManualSync(periodId: string, organizationId: string, actorProfileId: string) {
    const pending = await prisma.arcaSyncTask.findFirst({
        where: { periodId, status: { notIn: [...terminal] } }, orderBy: { updatedAt: "asc" }, select: { runKey: true },
    });
    if (pending) {
        await prisma.arcaSyncTask.updateMany({
            where: { periodId, runKey: pending.runKey, status: { in: RETRYABLE } },
            data: { status: "PENDING", actorProfileId, leaseUntil: null },
        });
        return;
    }
    // El bucket absorbe el doble clic simultáneo sin impedir una nueva corrida posterior.
    const runKey = `manual-${Math.floor(Date.now() / 1000)}`;
    await enqueueSync(periodId, organizationId, actorProfileId, runKey);
}

export async function enqueueScheduledSyncs(now: Date) {
    if (!connectorConfig()) return;
    const date = scheduleDate(now);
    const schedules = await prisma.arcaSyncSchedule.findMany({
        where: { enabled: true }, include: { client: { select: { cuit: true, periods: {
            where: { month: date.month, year: date.year, status: "OPEN" }, select: { id: true }, take: 1,
        } } } },
    });
    for (const schedule of schedules) {
        const period = schedule.client.periods[0];
        if (!period || !isScheduledDay(date, schedule.extraDays) || !syncCredentials(schedule.client.cuit.replace(/\D/g, ""))) continue;
        if (await canImport(schedule.actorProfileId, schedule.organizationId, schedule.clientId, ROLES_CONFIG)) {
            await enqueueSync(period.id, schedule.organizationId, schedule.actorProfileId, date.key);
        }
    }
}

export async function runNextSyncTask(periodId?: string) {
    const config = connectorConfig();
    if (!config) return false;
    const now = new Date();
    const available = [{ status: "PENDING" }, { status: "RUNNING", leaseUntil: { lt: now } }];
    const candidates = await prisma.arcaSyncTask.findMany({
        where: { ...(periodId ? { periodId } : {}), OR: available, period: { status: "OPEN" } },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: 4,
        include: { period: { select: { year: true, month: true, clientId: true, client: { select: { cuit: true } } } } },
    });
    if (!candidates.length) return false;
    const first = candidates[0];
    const task = candidates.find((item) => item.status === "RUNNING") ?? candidates.filter((item) => item.periodId === first.periodId && item.runKey === first.runKey)
        .sort((a, b) => sourceOrder.get(a.source)! - sourceOrder.get(b.source)!)[0];
    const leaseUntil = new Date(now.getTime() + 12 * 60_000);
    try {
        const claimed = await prisma.arcaSyncTask.updateMany({
            where: { id: task.id, OR: available }, data: { status: "RUNNING", leaseUntil },
        });
        if (!claimed.count) return false;
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
        throw error;
    }
    try {
        if (!(await canImport(task.actorProfileId, task.organizationId, task.period.clientId, ROLES_CREATE))) {
            await prisma.arcaSyncTask.updateMany({
                where: { id: task.id, leaseUntil },
                data: { status: "FAILED", errorCode: "ACCESS_REVOKED", leaseUntil: null },
            });
            return true;
        }
        const response = await fetch(config.url, {
            method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000),
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
            body: JSON.stringify({ taskId: task.id, lease: leaseUntil.toISOString() }),
        });
        if (response.status !== 202) throw new Error("DISPATCH_FAILED");
    } catch {
        await prisma.arcaSyncTask.updateMany({
            where: { id: task.id, status: "RUNNING", leaseUntil },
            data: { status: "FAILED", errorCode: "DISPATCH_FAILED", leaseUntil: null },
        });
    }
    return true;
}
