-- Usuarios del estudio: estado de la membresía, alcance de clientes, módulos,
-- invitaciones por correo y cupo de plazas. Migración EXPAND (aditiva).
--
-- Se apila DESPUÉS de todas las migraciones existentes (última:
-- 20261102120000_arca_production_controls) y NO modifica ninguna de ellas.
--
-- COMPATIBILIDAD CON LAS MEMBRESÍAS EXISTENTES
--   - "Membership"."status" NOT NULL DEFAULT 'ACTIVE', "clientScope" NOT NULL
--     DEFAULT 'ALL' y "modules" DEFAULT {CLIENTS, IVA, ARCA_PADRON}: toda
--     membresía existente conserva EXACTAMENTE el acceso que tenía (activa, con
--     todos los clientes y todos los módulos implementados). En PostgreSQL 11+
--     agregar columnas con DEFAULT constante no reescribe la tabla.
--   - El OWNER tiene alcance y módulos completos por regla de la aplicación
--     (lib/auth/permissions.ts), independientemente de estas columnas.
--   - "Organization"."seatLimit" NOT NULL DEFAULT 5. Si un estudio ya tuviera
--     más membresías que el cupo, nada se rompe: sólo no puede invitar más.
--   - Tablas nuevas vacías: "MembershipClient" y "OrganizationInvitation".
--
-- INTEGRIDAD
--   - "MembershipClient": FKs compuestas (id, organizationId) hacia Membership
--     y Client: imposible asignar un cliente de otro estudio. ON DELETE CASCADE.
--   - Índice único PARCIAL: una sola invitación PENDING por (estudio, correo).
--     Junto con el FOR UPDATE de la fila Organization (lib/users/seats.ts)
--     resiste invitaciones simultáneas.
--   - CHECK: seatLimit >= 1; email normalizado (trim + minúsculas, no vacío);
--     modules no NULL; una invitación no puede ser OWNER.
--   - Trigger "Membership_owner_continuity": ninguna sentencia puede dejar a un
--     estudio sin al menos un OWNER ACTIVE (UPDATE de role/status o DELETE de
--     la última membresía OWNER activa). TRUNCATE no dispara triggers de fila.
--     No referencia el esquema auth: reproducible en una base shadow.
--
-- TRANSACCIÓN Y LÍMITES: todo en una transacción explícita; lock_timeout acota
-- cada espera de bloqueo y statement_timeout cada sentencia (SET LOCAL).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "ClientScope" AS ENUM ('ALL', 'SELECTED');

-- CreateEnum
CREATE TYPE "AppModule" AS ENUM ('CLIENTS', 'IVA', 'ARCA_PADRON');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "clientScope" "ClientScope" NOT NULL DEFAULT 'ALL',
ADD COLUMN     "disabledAt" TIMESTAMP(3),
ADD COLUMN     "modules" "AppModule"[] DEFAULT ARRAY['CLIENTS', 'IVA', 'ARCA_PADRON']::"AppModule"[],
ADD COLUMN     "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "seatLimit" INTEGER NOT NULL DEFAULT 5;

-- CreateTable
CREATE TABLE "MembershipClient" (
    "membershipId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MembershipClient_pkey" PRIMARY KEY ("membershipId","clientId")
);

-- CreateTable
CREATE TABLE "OrganizationInvitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "clientScope" "ClientScope" NOT NULL,
    "modules" "AppModule"[],
    "clientIds" TEXT[],
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invitedById" UUID,
    "authUserId" UUID,
    "lastSentAt" TIMESTAMP(3),
    "sendCount" INTEGER NOT NULL DEFAULT 0,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MembershipClient_clientId_idx" ON "MembershipClient"("clientId");

-- CreateIndex
CREATE INDEX "MembershipClient_organizationId_idx" ON "MembershipClient"("organizationId");

-- CreateIndex
CREATE INDEX "OrganizationInvitation_organizationId_status_idx" ON "OrganizationInvitation"("organizationId", "status");

-- CreateIndex
CREATE INDEX "OrganizationInvitation_email_idx" ON "OrganizationInvitation"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_id_organizationId_key" ON "Membership"("id", "organizationId");

-- Una sola invitación PENDING por estudio y correo (índice único parcial).
CREATE UNIQUE INDEX "OrganizationInvitation_pending_email_key" ON "OrganizationInvitation"("organizationId", "email") WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "MembershipClient" ADD CONSTRAINT "MembershipClient_membershipId_organizationId_fkey" FOREIGN KEY ("membershipId", "organizationId") REFERENCES "Membership"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipClient" ADD CONSTRAINT "MembershipClient_clientId_organizationId_fkey" FOREIGN KEY ("clientId", "organizationId") REFERENCES "Client"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddCheckConstraint
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_seatLimit_check" CHECK ("seatLimit" >= 1);
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_modules_check" CHECK ("modules" IS NOT NULL);
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_email_check" CHECK ("email" = lower(btrim("email")) AND length("email") > 0);
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_lists_check" CHECK ("modules" IS NOT NULL AND "clientIds" IS NOT NULL);
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_role_check" CHECK ("role" <> 'OWNER');

-- Continuidad del acceso: nunca un estudio sin OWNER ACTIVE.
CREATE FUNCTION "membership_owner_continuity"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."role" = 'OWNER' AND OLD."status" = 'ACTIVE' THEN
    IF TG_OP = 'DELETE' OR NEW."role" <> 'OWNER' OR NEW."status" <> 'ACTIVE'
       OR NEW."organizationId" <> OLD."organizationId" THEN
      -- Borrado en cascada del propio estudio: no hay continuidad que cuidar.
      IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1 FROM "Organization" o WHERE o."id" = OLD."organizationId"
      ) THEN
        RETURN OLD;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM "Membership" m
        WHERE m."organizationId" = OLD."organizationId"
          AND m."id" <> OLD."id"
          AND m."role" = 'OWNER'
          AND m."status" = 'ACTIVE'
      ) THEN
        RAISE EXCEPTION 'el estudio debe conservar al menos un propietario activo'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'Membership_owner_continuity';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Membership_owner_continuity"
BEFORE UPDATE OF "role", "status", "organizationId" OR DELETE ON "Membership"
FOR EACH ROW EXECUTE FUNCTION "membership_owner_continuity"();

-- Tablas nuevas: sólo las usa el servidor (Prisma, rol propietario). RLS sin
-- políticas y sin privilegios para PUBLIC ni para los roles de la API de
-- Supabase (mismo criterio que las tablas técnicas de ARCA): las invitaciones
-- guardan correos y no deben quedar expuestas por PostgREST.
DO $tables$
DECLARE t TEXT; r TEXT;
BEGIN
 FOREACH t IN ARRAY ARRAY['MembershipClient', 'OrganizationInvitation'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', t);
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
   EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r);
  END LOOP;
 END LOOP;
END
$tables$;

COMMIT;
