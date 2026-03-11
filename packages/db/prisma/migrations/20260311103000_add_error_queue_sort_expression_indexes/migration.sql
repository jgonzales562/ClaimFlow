-- Prisma schema cannot express these partial expression indexes.
-- They are targeted to the error queue's non-default sort shapes.
CREATE INDEX "Claim_error_failure_count_sort_idx"
  ON "Claim"(
    "organizationId",
    (COALESCE("latestWorkerFailureReceiveCount", -1)),
    "updatedAt" DESC,
    id DESC
  )
  WHERE status = 'ERROR';

CREATE INDEX "Claim_error_failure_oldest_sort_idx"
  ON "Claim"(
    "organizationId",
    (COALESCE("latestWorkerFailureAt", "updatedAt")),
    id
  )
  WHERE status = 'ERROR';
