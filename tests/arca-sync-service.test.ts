import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/lib/prisma";
import { runNextSyncTask, startManualSync } from "@/lib/arca-sync/service";

vi.mock("@/lib/prisma", () => ({
    default: {
        arcaSyncTask: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), createMany: vi.fn(), count: vi.fn() },
        arcaSyncFile: { deleteMany: vi.fn() },
        period: { findFirst: vi.fn() },
        membership: { findUnique: vi.fn() },
    },
}));

const task = {
    id: "task-a", periodId: "period", organizationId: "org", actorProfileId: "profile",
    source: "PURCHASES", runKey: "run", status: "PENDING",
    period: { year: 2026, month: 10, clientId: "client", client: { cuit: "20-12345678-9" } },
};

describe("importación programada de ARCA", () => {
    beforeEach(() => {
        vi.stubEnv("ARCA_SYNC_APP_ORIGIN", "https://connector.example.test/");
        vi.stubEnv("ARCA_SYNC_CREDENTIALS", "{}");
        vi.stubEnv("ARCA_SYNC_CONNECTOR_TOKEN", "a".repeat(32));
        vi.mocked(prisma.arcaSyncTask.findMany).mockResolvedValue([task] as never);
        vi.mocked(prisma.arcaSyncTask.updateMany).mockResolvedValue({ count: 1 });
        vi.mocked(prisma.membership.findUnique).mockResolvedValue({ id: "member", status: "ACTIVE", role: "OWNER" } as never);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.resetAllMocks();
    });

    it("despacha la fuente con una concesión persistida y conserva RUNNING hasta recibir el resultado", async () => {
        const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
        vi.stubGlobal("fetch", fetcher);
        await expect(runNextSyncTask("period")).resolves.toBe(true);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(fetcher.mock.calls[0][0].pathname).toBe("/_arca-sync/worker");
        expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
            taskId: "task-a", lease: expect.any(String),
        });
        expect(prisma.arcaSyncTask.updateMany).toHaveBeenCalledOnce();
        expect(prisma.arcaSyncTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: "RUNNING" }),
        }));
    });

    it("al retomar sólo vuelve a poner en cola las fuentes fallidas", async () => {
        vi.mocked(prisma.arcaSyncTask.findFirst).mockResolvedValue({ runKey: "existing" } as never);
        await startManualSync("period", "org", "profile");
        expect(prisma.arcaSyncTask.createMany).not.toHaveBeenCalled();
        expect(prisma.arcaSyncTask.updateMany).toHaveBeenCalledWith({
            where: { periodId: "period", runKey: "existing", status: { in: ["FAILED", "AUTH_REQUIRED"] } },
            data: { status: "PENDING", actorProfileId: "profile", leaseUntil: null, errorCode: null },
        });
    });

    it("con vistas previas sin resolver no vuelve a descargar", async () => {
        vi.mocked(prisma.arcaSyncTask.findFirst).mockResolvedValue({ runKey: "existing" } as never);
        vi.mocked(prisma.arcaSyncTask.updateMany).mockResolvedValue({ count: 0 });
        vi.mocked(prisma.arcaSyncTask.count).mockResolvedValue(2);
        await expect(startManualSync("period", "org", "profile")).resolves.toBe("AWAITING_DECISION");
        expect(prisma.arcaSyncTask.count).toHaveBeenCalledWith({ where: { periodId: "period", runKey: "existing", status: { in: ["PREVIEW", "CONFIRMING"] } } });
        expect(prisma.arcaSyncTask.createMany).not.toHaveBeenCalled();
    });

    it("una corrida nueva descarta las vistas previas anteriores y borra los archivos de las corridas anteriores", async () => {
        vi.mocked(prisma.arcaSyncTask.findFirst).mockResolvedValue(null);
        vi.mocked(prisma.period.findFirst).mockResolvedValue({ clientId: "client" } as never);
        vi.mocked(prisma.arcaSyncTask.createMany).mockResolvedValue({ count: 4 });
        await expect(startManualSync("period", "org", "profile")).resolves.toBe("STARTED");
        const older = { not: expect.stringMatching(/^manual-\d+$/) };
        expect(prisma.arcaSyncFile.deleteMany).toHaveBeenCalledWith({ where: { task: { periodId: "period", runKey: older } } });
        expect(prisma.arcaSyncTask.updateMany).toHaveBeenCalledWith({ where: { periodId: "period", runKey: older, status: "PREVIEW" }, data: { status: "DISCARDED" } });
    });
});
