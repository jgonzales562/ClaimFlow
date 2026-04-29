CREATE TYPE "AuditEventType" AS ENUM ('CLAIM_EXPORT', 'ATTACHMENT_ACCESS');

ALTER TABLE "InboundMessage"
  ADD COLUMN "rawPayloadRedactedAt" TIMESTAMP(3),
  ADD COLUMN "retentionExpiresAt" TIMESTAMP(3);

ALTER TABLE "ClaimAttachment"
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "retentionExpiresAt" TIMESTAMP(3);

ALTER TABLE "ClaimExtraction"
  ADD COLUMN "rawOutputRedactedAt" TIMESTAMP(3),
  ADD COLUMN "retentionExpiresAt" TIMESTAMP(3);

CREATE TABLE "AuditEvent" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "eventType" "AuditEventType" NOT NULL,
  "payloadSchemaVersion" INTEGER NOT NULL DEFAULT 1,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AuditEvent_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AuditEvent_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "InboundMessage_retention_redaction_idx"
  ON "InboundMessage"("retentionExpiresAt", "rawPayloadRedactedAt");

CREATE INDEX "ClaimAttachment_retention_delete_idx"
  ON "ClaimAttachment"("retentionExpiresAt", "deletedAt");

CREATE INDEX "ClaimExtraction_retention_redaction_idx"
  ON "ClaimExtraction"("retentionExpiresAt", "rawOutputRedactedAt");

CREATE INDEX "AuditEvent_organizationId_createdAt_idx"
  ON "AuditEvent"("organizationId", "createdAt");

CREATE INDEX "AuditEvent_organizationId_eventType_createdAt_idx"
  ON "AuditEvent"("organizationId", "eventType", "createdAt");

CREATE INDEX "AuditEvent_actorUserId_createdAt_idx"
  ON "AuditEvent"("actorUserId", "createdAt");
