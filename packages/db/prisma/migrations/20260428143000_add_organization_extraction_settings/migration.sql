ALTER TYPE "AuditEventType" ADD VALUE 'EXTRACTION_SETTINGS_UPDATE';

CREATE TABLE "OrganizationExtractionSettings" (
  "organizationId" TEXT NOT NULL,
  "scanKeywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OrganizationExtractionSettings_pkey" PRIMARY KEY ("organizationId"),
  CONSTRAINT "OrganizationExtractionSettings_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "ClaimExtraction" ALTER COLUMN "schemaVersion" SET DEFAULT 2;
