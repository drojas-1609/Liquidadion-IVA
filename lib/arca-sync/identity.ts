import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

interface SyncIdentity {
    profileId: string;
    organizationId: string;
    periodId: string;
}

// Únicamente la ruta interna autenticada establece esta identidad. Las rutas
// públicas siguen usando Supabase y cada importador relee permisos y alcance.
const identity = new AsyncLocalStorage<SyncIdentity>();
export const currentSyncIdentity = () => identity.getStore();
export function withSyncIdentity<T>(value: SyncIdentity, callback: () => Promise<T>) {
    return identity.run(value, callback);
}
