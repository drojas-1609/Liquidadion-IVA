import type { AppModule, ClientScope, Role } from "@prisma/client";

/**
 * Contrato de Configuración → Usuarios hacia la UI (sin `server-only`: lo
 * importa el componente cliente). Sólo datos del propio estudio; sin tokens,
 * auth.users.id ni datos de sesión.
 */

export interface SeatUsage {
  limit: number;
  active: number;
  pending: number;
  used: number;
  available: number;
}

export interface MemberView {
  id: string;
  email: string;
  fullName: string | null;
  role: Role;
  status: "ACTIVE" | "DISABLED";
  clientScope: ClientScope;
  clientIds: string[];
  modules: AppModule[];
  isSelf: boolean;
  createdAt: string;
}

export interface InvitationView {
  id: string;
  email: string;
  role: Role;
  clientScope: ClientScope;
  clientCount: number;
  modules: AppModule[];
  expiresAt: string;
  expired: boolean;
  lastSentAt: string | null;
}

export interface UsersOverview {
  seats: SeatUsage;
  members: MemberView[];
  invitations: InvitationView[];
  clients: { id: string; name: string; cuit: string }[];
}

