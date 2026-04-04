-- Align dashboard/export pagination with deterministic claim ordering and
-- add org-scoped outbox indexes for the admin backlog snapshot queries.
DROP INDEX IF EXISTS "Claim_organizationId_status_createdAt_idx";
CREATE INDEX IF NOT EXISTS "Claim_organizationId_status_createdAt_id_idx"
  ON "Claim" ("organizationId", "status", "createdAt", "id");

DROP INDEX IF EXISTS "ClaimIngestQueueOutbox_organizationId_createdAt_idx";
DROP INDEX IF EXISTS "ClaimIngestQueueOutbox_dispatch_state_idx";
CREATE INDEX IF NOT EXISTS "ClaimIngestQueueOutbox_dispatch_state_idx"
  ON "ClaimIngestQueueOutbox" ("dispatchedAt", "availableAt", "createdAt", "id");

CREATE INDEX IF NOT EXISTS "ClaimIngestQueueOutbox_org_dispatch_created_id_idx"
  ON "ClaimIngestQueueOutbox" ("organizationId", "dispatchedAt", "createdAt", "id");

CREATE INDEX IF NOT EXISTS "ClaimIngestQueueOutbox_org_dispatch_available_id_idx"
  ON "ClaimIngestQueueOutbox" ("organizationId", "dispatchedAt", "availableAt", "id");
