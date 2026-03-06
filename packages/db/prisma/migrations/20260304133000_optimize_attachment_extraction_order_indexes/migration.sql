-- Align attachment/extraction indexes with deterministic ORDER BY (createdAt, id)
-- and remove redundant single-column claimId attachment index.
DROP INDEX IF EXISTS "ClaimAttachment_claimId_idx";

DROP INDEX IF EXISTS "ClaimAttachment_claimId_uploadStatus_createdAt_idx";
CREATE INDEX IF NOT EXISTS "ClaimAttachment_claimId_uploadStatus_createdAt_id_idx"
  ON "ClaimAttachment" ("claimId", "uploadStatus", "createdAt", "id");

CREATE INDEX IF NOT EXISTS "ClaimAttachment_claimId_createdAt_id_idx"
  ON "ClaimAttachment" ("claimId", "createdAt", "id");

DROP INDEX IF EXISTS "ClaimExtraction_claimId_createdAt_idx";
CREATE INDEX IF NOT EXISTS "ClaimExtraction_claimId_createdAt_id_idx"
  ON "ClaimExtraction" ("claimId", "createdAt", "id");
