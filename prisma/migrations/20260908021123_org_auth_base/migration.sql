-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER');

-- DropIndex
DROP INDEX "Client_cuit_key";

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "createdById" UUID,
ADD COLUMN     "organizationId" TEXT NOT NULL,
ADD COLUMN     "updatedById" UUID;

-- AlterTable
ALTER TABLE "Period" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "createdById" UUID,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "updatedById" UUID;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "createdById" UUID,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "updatedById" UUID;

-- AlterTable
ALTER TABLE "TaxRecord" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "createdById" UUID,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "updatedById" UUID;

-- CreateTable
CREATE TABLE "Profile" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "profileId" UUID NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgSetting" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Profile_email_idx" ON "Profile"("email");

-- CreateIndex
CREATE INDEX "Membership_organizationId_idx" ON "Membership"("organizationId");

-- CreateIndex
CREATE INDEX "Membership_profileId_idx" ON "Membership"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_profileId_organizationId_key" ON "Membership"("profileId", "organizationId");

-- CreateIndex
CREATE INDEX "OrgSetting_organizationId_idx" ON "OrgSetting"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgSetting_organizationId_key_key" ON "OrgSetting"("organizationId", "key");

-- CreateIndex
CREATE INDEX "Client_organizationId_idx" ON "Client"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Client_organizationId_cuit_key" ON "Client"("organizationId", "cuit");

-- CreateIndex
CREATE INDEX "Period_clientId_idx" ON "Period"("clientId");

-- CreateIndex
CREATE INDEX "Invoice_periodId_idx" ON "Invoice"("periodId");

-- CreateIndex
CREATE INDEX "TaxRecord_periodId_idx" ON "TaxRecord"("periodId");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgSetting" ADD CONSTRAINT "OrgSetting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Period" ADD CONSTRAINT "Period_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Period" ADD CONSTRAINT "Period_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxRecord" ADD CONSTRAINT "TaxRecord_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxRecord" ADD CONSTRAINT "TaxRecord_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

