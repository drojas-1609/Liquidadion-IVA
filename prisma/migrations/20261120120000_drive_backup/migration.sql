-- Fase C4: respaldo de comprobantes en Google Drive.
CREATE TABLE "DriveConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" VARCHAR(200),
    "refreshTokenSealed" TEXT NOT NULL,
    "rootFolderId" VARCHAR(100) NOT NULL,
    "rootFolderName" VARCHAR(200) NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connectedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DriveConnection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DriveConnection_organizationId_key" ON "DriveConnection"("organizationId");

CREATE TABLE "DriveFolder" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "path" VARCHAR(600) NOT NULL,
    "folderId" VARCHAR(100) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DriveFolder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DriveFolder_organizationId_path_key" ON "DriveFolder"("organizationId", "path");

CREATE TABLE "DocumentBackup" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "periodId" TEXT,
    "category" VARCHAR(20) NOT NULL,
    "source" VARCHAR(40) NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "folderPath" VARCHAR(600) NOT NULL,
    "fileName" VARCHAR(255) NOT NULL,
    "mimeType" VARCHAR(120) NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "content" BYTEA,
    "status" VARCHAR(10) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(300),
    "driveFileId" VARCHAR(100),
    "driveLink" VARCHAR(300),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedAt" TIMESTAMP(3),
    "createdById" UUID,
    CONSTRAINT "DocumentBackup_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DocumentBackup_status_check" CHECK ("status" IN ('PENDING', 'DONE', 'ERROR')),
    CONSTRAINT "DocumentBackup_category_check" CHECK ("category" IN ('IVA_VENTAS', 'IVA_COMPRAS', 'IVA_RET_PERC', 'IVA_DDJJ', 'IIBB_RET_PERC', 'IIBB_DDJJ', 'BANCOS', 'SUELDOS', 'CONTABILIDAD')),
    CONSTRAINT "DocumentBackup_content_check" CHECK ("status" <> 'DONE' OR "content" IS NULL),
    CONSTRAINT "DocumentBackup_size_check" CHECK ("size" >= 0 AND "size" <= 20971520)
);
CREATE UNIQUE INDEX "DocumentBackup_clientId_category_sha256_key" ON "DocumentBackup"("clientId", "category", "sha256");
CREATE INDEX "DocumentBackup_organizationId_status_idx" ON "DocumentBackup"("organizationId", "status");
CREATE INDEX "DocumentBackup_clientId_organizationId_createdAt_idx" ON "DocumentBackup"("clientId", "organizationId", "createdAt");
ALTER TABLE "DocumentBackup" ADD CONSTRAINT "DocumentBackup_clientId_organizationId_fkey"
    FOREIGN KEY ("clientId", "organizationId") REFERENCES "Client"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DriveConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DriveFolder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentBackup" ENABLE ROW LEVEL SECURITY;
