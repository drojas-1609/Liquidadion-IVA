import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireOrganizationRole, withApiAuthz } from "@/lib/auth/authz";
import { ROLES_CONFIG } from "@/lib/auth/roles";
import { ValidationError } from "@/lib/auth/errors";
import { authUrl, driveOAuthConfig } from "@/lib/drive/google";
import { driveTokenKey } from "@/lib/drive/backup-service";

const STATE_COOKIE = "drive_oauth_state";

// GET /api/drive/connect — inicia la conexión de Google Drive (OAuth). Sólo
// propietario o administrador. El estado anti-CSRF viaja en una cookie httpOnly.
export const GET = withApiAuthz(async (request: Request) => {
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_CONFIG, { module: "CLIENTS" });
    const cfg = driveOAuthConfig();
    if (!cfg || !driveTokenKey()) throw new ValidationError("Falta configurar en Netlify GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET y DRIVE_TOKEN_KEY.", "drive");
    const origin = new URL(request.url).origin;
    const state = randomBytes(24).toString("hex");
    const res = NextResponse.redirect(authUrl(cfg.clientId, `${origin}/api/drive/callback`, state), 302);
    res.cookies.set(STATE_COOKIE, `${state}.${organizationId}`, { httpOnly: true, secure: true, sameSite: "lax", path: "/api/drive", maxAge: 600 });
    return res;
});
