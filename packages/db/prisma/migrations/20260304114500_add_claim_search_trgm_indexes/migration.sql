-- Speed up case-insensitive contains search over claim text fields.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Claim_externalClaimId_trgm_idx"
  ON "Claim" USING GIN ("externalClaimId" gin_trgm_ops)
  WHERE "externalClaimId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "Claim_customerName_trgm_idx"
  ON "Claim" USING GIN ("customerName" gin_trgm_ops)
  WHERE "customerName" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "Claim_productName_trgm_idx"
  ON "Claim" USING GIN ("productName" gin_trgm_ops)
  WHERE "productName" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "Claim_issueSummary_trgm_idx"
  ON "Claim" USING GIN ("issueSummary" gin_trgm_ops)
  WHERE "issueSummary" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "Claim_sourceEmail_trgm_idx"
  ON "Claim" USING GIN ("sourceEmail" gin_trgm_ops)
  WHERE "sourceEmail" IS NOT NULL;
