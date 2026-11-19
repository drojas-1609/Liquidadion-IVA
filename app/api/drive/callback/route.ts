import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { timingSafeEqual } from "node:crypto";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireOrganizationRole, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_CONFIG } from "@/lib/auth/roles";
import { accountEmail, createFolder, driveOAuthConfig, exchangeCode, findFolder } from "@/lib/drive/google";
import { driveTokenKey, sealToken } from "@/lib/drive/backup-service";

const STATE_COOKIE = "drive_oauth_state";

/** Nombre de la carpeta raíz en «Mi unidad» (en las vistas previas conviene una de prueba). */
const driveRootName = () => process.env.DRIVE_ROOT_FOLDER_NAME?.trim() || "DERO COMPANY GESTIÓN";

const back = (origin: string, q: string) => NextResponse.redirect(`${origin}/settings/drive?${q}`, 302);

// GET /api/drive/callback — vuelta de Google: valida el estado, guarda el
// refresh token cifrado y ubica (o crea) la carpeta raíz en «Mi unidad».
export const GET = withApiAuthz(async (request: Request) => {
    const url = new URL(request.url);
    const origin = url.origin;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_CONFIG, { module: "CLIENTS" });
    const jar = await cookies();
    const saved = jar.get(STATE_COOKIE)?.value ?? "";
    jar.delete({ name: STATE_COOKIE, path: "/api/drive" });
    const [state, org] = saved.split(".");
    const got = url.searchParams.get("state") ?? "";
    const okState = state && got.length === state.length && timingSafeEqual(Buffer.from(state), Buffer.from(got)) && org === organizationId;
    if (!okState) return back(origin, "error=estado");
    if (url.searchParams.get("error")) return back(origin, "error=cancelado");
    const code = url.searchParams.get("code");
    const cfg = driveOAuthConfig();
    const key = driveTokenKey();
    if (!code || !cfg || !key) return back(origin, "error=config");

    let tokens;
    try { tokens = await exchangeCode(cfg, code, `${origin}/api/drive/callback`); } catch { return back(origin, "error=google"); }
    if (!tokens.refresh_token) return back(origin, "error=sin_refresh");
    const email = await accountEmail(tokens.access_token).catch(() => null);
    const rootName = driveRootName();
    let rootId: string;
    try { rootId = (await findFolder(tokens.access_token, "root", rootName)) ?? (await createFolder(tokens.access_token, "root", rootName)); } catch { return back(origin, "error=carpeta"); }

    await prisma.$transaction(async (tx) => {
        const data = { email, refreshTokenSealed: sealToken(tokens.refresh_token!, organizationId, key), rootFolderId: rootId, rootFolderName: rootName, connectedById: profileId, connectedAt: new Date() };
        await tx.driveConnection.upsert({ where: { organizationId }, create: { organizationId, ...data }, update: data });
        // Otra cuenta o raíz: las carpetas en caché ya no sirven.
        await tx.driveFolder.deleteMany({ where: { organizationId } });
        await recordAudit(tx, { organizationId, actorProfileId: profileId, action: "drive.connect", targetType: "Organization", targetId: organizationId, metadata: { rootFolderName: rootName } });
    });
    return back(origin, "ok=1");
});
