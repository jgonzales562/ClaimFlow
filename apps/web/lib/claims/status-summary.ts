import { Prisma } from "@prisma/client";
import { prisma } from "@claimflow/db";
import { CLAIM_STATUSES, type ClaimStatus } from "./filters";

type ClaimStatusSummaryRow = {
  totalClaims: number;
  newCount: number;
  processingCount: number;
  reviewRequiredCount: number;
  readyCount: number;
  errorCount: number;
  staleProcessingCount: number;
  staleProcessingOrganizationCount: number;
};

export type ClaimStatusSummary = {
  totalClaims: number;
  statusCounts: Record<ClaimStatus, number>;
  staleProcessingCount: number;
  staleProcessingOrganizationCount: number;
};

export async function loadClaimStatusSummary(input: {
  staleProcessingBefore: Date;
  organizationId?: string;
}): Promise<ClaimStatusSummary> {
  const staleProcessingFilterSql = Prisma.sql`
    status = 'PROCESSING'
    AND "updatedAt" <= ${input.staleProcessingBefore}
  `;
  const staleProcessingOrganizationCountSql = input.organizationId
    ? Prisma.sql`
        CASE
          WHEN COUNT(*) FILTER (WHERE ${staleProcessingFilterSql}) > 0 THEN 1
          ELSE 0
        END::int
      `
    : Prisma.sql`
        COUNT(DISTINCT "organizationId") FILTER (
          WHERE ${staleProcessingFilterSql}
        )::int
      `;

  const rows = await prisma.$queryRaw<Array<ClaimStatusSummaryRow>>(Prisma.sql`
    SELECT
      COUNT(*)::int AS "totalClaims",
      COUNT(*) FILTER (WHERE status = 'NEW')::int AS "newCount",
      COUNT(*) FILTER (WHERE status = 'PROCESSING')::int AS "processingCount",
      COUNT(*) FILTER (WHERE status = 'REVIEW_REQUIRED')::int AS "reviewRequiredCount",
      COUNT(*) FILTER (WHERE status = 'READY')::int AS "readyCount",
      COUNT(*) FILTER (WHERE status = 'ERROR')::int AS "errorCount",
      COUNT(*) FILTER (WHERE ${staleProcessingFilterSql})::int AS "staleProcessingCount",
      ${staleProcessingOrganizationCountSql} AS "staleProcessingOrganizationCount"
    FROM "Claim"
    ${input.organizationId ? Prisma.sql`WHERE "organizationId" = ${input.organizationId}` : Prisma.empty}
  `);

  const row = rows[0] ?? {
    totalClaims: 0,
    newCount: 0,
    processingCount: 0,
    reviewRequiredCount: 0,
    readyCount: 0,
    errorCount: 0,
    staleProcessingCount: 0,
    staleProcessingOrganizationCount: 0,
  };

  const statusCounts = Object.fromEntries(
    CLAIM_STATUSES.map((status) => [status, 0]),
  ) as Record<ClaimStatus, number>;

  statusCounts.NEW = row.newCount;
  statusCounts.PROCESSING = row.processingCount;
  statusCounts.REVIEW_REQUIRED = row.reviewRequiredCount;
  statusCounts.READY = row.readyCount;
  statusCounts.ERROR = row.errorCount;

  return {
    totalClaims: row.totalClaims,
    statusCounts,
    staleProcessingCount: row.staleProcessingCount,
    staleProcessingOrganizationCount: row.staleProcessingOrganizationCount,
  };
}
