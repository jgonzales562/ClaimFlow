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
  const [summaryRows, staleRows] = await Promise.all([
    loadPrecomputedClaimStatusSummary(input.organizationId),
    loadLiveStaleProcessingSummary(input.staleProcessingBefore, input.organizationId),
  ]);

  const summaryRow = summaryRows[0] ?? {
    totalClaims: 0,
    newCount: 0,
    processingCount: 0,
    reviewRequiredCount: 0,
    readyCount: 0,
    errorCount: 0,
    staleProcessingCount: 0,
    staleProcessingOrganizationCount: 0,
  };
  const staleRow = staleRows[0] ?? {
    staleProcessingCount: 0,
    staleProcessingOrganizationCount: 0,
  };

  const statusCounts = Object.fromEntries(
    CLAIM_STATUSES.map((status) => [status, 0]),
  ) as Record<ClaimStatus, number>;

  statusCounts.NEW = summaryRow.newCount;
  statusCounts.PROCESSING = summaryRow.processingCount;
  statusCounts.REVIEW_REQUIRED = summaryRow.reviewRequiredCount;
  statusCounts.READY = summaryRow.readyCount;
  statusCounts.ERROR = summaryRow.errorCount;

  return {
    totalClaims: summaryRow.totalClaims,
    statusCounts,
    staleProcessingCount: staleRow.staleProcessingCount,
    staleProcessingOrganizationCount: staleRow.staleProcessingOrganizationCount,
  };
}

async function loadPrecomputedClaimStatusSummary(
  organizationId: string | undefined,
): Promise<ClaimStatusSummaryRow[]> {
  if (organizationId) {
    return prisma.$queryRaw<Array<ClaimStatusSummaryRow>>(Prisma.sql`
      SELECT
        "totalClaims"::int AS "totalClaims",
        "newCount"::int AS "newCount",
        "processingCount"::int AS "processingCount",
        "reviewRequiredCount"::int AS "reviewRequiredCount",
        "readyCount"::int AS "readyCount",
        "errorCount"::int AS "errorCount",
        0::int AS "staleProcessingCount",
        0::int AS "staleProcessingOrganizationCount"
      FROM "ClaimOrganizationSummary"
      WHERE "organizationId" = ${organizationId}
    `);
  }

  return prisma.$queryRaw<Array<ClaimStatusSummaryRow>>(Prisma.sql`
    SELECT
      COALESCE(SUM("totalClaims"), 0)::int AS "totalClaims",
      COALESCE(SUM("newCount"), 0)::int AS "newCount",
      COALESCE(SUM("processingCount"), 0)::int AS "processingCount",
      COALESCE(SUM("reviewRequiredCount"), 0)::int AS "reviewRequiredCount",
      COALESCE(SUM("readyCount"), 0)::int AS "readyCount",
      COALESCE(SUM("errorCount"), 0)::int AS "errorCount",
      0::int AS "staleProcessingCount",
      0::int AS "staleProcessingOrganizationCount"
    FROM "ClaimOrganizationSummary"
  `);
}

async function loadLiveStaleProcessingSummary(
  staleProcessingBefore: Date,
  organizationId: string | undefined,
): Promise<Pick<ClaimStatusSummaryRow, "staleProcessingCount" | "staleProcessingOrganizationCount">[]> {
  if (organizationId) {
    return prisma.$queryRaw<
      Array<Pick<ClaimStatusSummaryRow, "staleProcessingCount" | "staleProcessingOrganizationCount">>
    >(Prisma.sql`
      SELECT
        COUNT(*)::int AS "staleProcessingCount",
        CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END::int AS "staleProcessingOrganizationCount"
      FROM "Claim"
      WHERE "organizationId" = ${organizationId}
        AND status = 'PROCESSING'
        AND "updatedAt" <= ${staleProcessingBefore}
    `);
  }

  return prisma.$queryRaw<
    Array<Pick<ClaimStatusSummaryRow, "staleProcessingCount" | "staleProcessingOrganizationCount">>
  >(Prisma.sql`
    SELECT
      COUNT(*)::int AS "staleProcessingCount",
      COUNT(DISTINCT "organizationId")::int AS "staleProcessingOrganizationCount"
    FROM "Claim"
    WHERE status = 'PROCESSING'
      AND "updatedAt" <= ${staleProcessingBefore}
  `);
}
