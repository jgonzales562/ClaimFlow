-- Align index keys with deterministic ORDER BY patterns used in paginated queries.
DROP INDEX IF EXISTS "Claim_organizationId_status_updatedAt_idx";
CREATE INDEX IF NOT EXISTS "Claim_organizationId_status_updatedAt_id_idx"
  ON "Claim" ("organizationId", "status", "updatedAt", "id");

DROP INDEX IF EXISTS "ClaimEvent_claimId_createdAt_idx";
CREATE INDEX IF NOT EXISTS "ClaimEvent_claimId_createdAt_id_idx"
  ON "ClaimEvent" ("claimId", "createdAt", "id");

DROP INDEX IF EXISTS "ClaimEvent_claimId_eventType_createdAt_idx";
CREATE INDEX IF NOT EXISTS "ClaimEvent_claimId_eventType_createdAt_id_idx"
  ON "ClaimEvent" ("claimId", "eventType", "createdAt", "id");
