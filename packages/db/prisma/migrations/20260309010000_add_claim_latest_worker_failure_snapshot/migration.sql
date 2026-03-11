ALTER TABLE "Claim"
  ADD COLUMN "latestWorkerFailureAt" TIMESTAMP(3),
  ADD COLUMN "latestWorkerFailureReason" TEXT,
  ADD COLUMN "latestWorkerFailureRetryable" BOOLEAN,
  ADD COLUMN "latestWorkerFailureReceiveCount" INTEGER,
  ADD COLUMN "latestWorkerFailureDisposition" TEXT;

WITH latest_failure AS (
  SELECT DISTINCT ON (e."claimId")
    e."claimId",
    e."createdAt",
    e.payload,
    e.id
  FROM "ClaimEvent" e
  WHERE e."eventType" = 'STATUS_TRANSITION'
    AND e.payload->>'source' = 'worker_failure'
  ORDER BY e."claimId", e."createdAt" DESC, e.id DESC
)
UPDATE "Claim" AS c
SET
  "latestWorkerFailureAt" = latest_failure."createdAt",
  "latestWorkerFailureReason" = latest_failure.payload->>'reason',
  "latestWorkerFailureRetryable" = CASE
    WHEN latest_failure.payload->>'retryable' = 'true' THEN TRUE
    WHEN latest_failure.payload->>'retryable' = 'false' THEN FALSE
    ELSE NULL
  END,
  "latestWorkerFailureReceiveCount" = CASE
    WHEN jsonb_typeof(latest_failure.payload->'receiveCount') = 'number'
      THEN (latest_failure.payload->>'receiveCount')::int
    ELSE NULL
  END,
  "latestWorkerFailureDisposition" = latest_failure.payload->>'failureDisposition'
FROM latest_failure
WHERE latest_failure."claimId" = c.id;

CREATE INDEX "Claim_error_failure_at_idx"
  ON "Claim"("organizationId", status, "latestWorkerFailureAt", id);

CREATE INDEX "Claim_error_failure_count_idx"
  ON "Claim"(
    "organizationId",
    status,
    "latestWorkerFailureReceiveCount",
    "updatedAt",
    id
  );
