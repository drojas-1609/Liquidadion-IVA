import { ACTIVE_CLIENT_COOKIE } from "@/lib/navigation/cookie";

/** Guarda (sólo el id) el último cliente elegido, por un año. */
export function rememberClient(id: string | null): void {
    document.cookie = id
        ? `${ACTIVE_CLIENT_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax; secure`
        : `${ACTIVE_CLIENT_COOKIE}=; path=/; max-age=0; samesite=lax; secure`;
}
