CREATE INDEX "Claim_error_retryable_idx"
  ON "Claim"(
    "organizationId",
    status,
    "latestWorkerFailureRetryable",
    "updatedAt",
    id
  );

CREATE INDEX "Claim_error_disposition_idx"
  ON "Claim"(
    "organizationId",
    status,
    "latestWorkerFailureDisposition",
    "updatedAt",
    id
  );
