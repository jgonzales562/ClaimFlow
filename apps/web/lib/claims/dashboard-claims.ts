import { prisma } from "@claimflow/db";
import type { Prisma } from "@prisma/client";
import {
  applyTimestampCursor,
  encodeTimestampCursor,
  type PageDirection,
  type TimestampCursor,
} from "./cursor-pagination";
import {
  buildClaimWhereInput,
  CLAIM_STATUSES,
  type ClaimFilters,
  type ClaimStatus,
} from "./filters";
import { getClaimProcessingStaleBefore, isClaimProcessingStale } from "./processing-health";

export type DashboardClaimRecord = {
  id: string;
  externalClaimId: string | null;
  customerName: string | null;
  productName: string | null;
  status: ClaimStatus;
  warrantyStatus: "LIKELY_IN_WARRANTY" | "LIKELY_EXPIRED" | "UNCLEAR";
  createdAt: Date;
  updatedAt: Date;
  isProcessingStale: boolean;
};

export type DashboardStatusCounts = Record<ClaimStatus, number>;

export type DashboardClaimsPage = {
  claims: DashboardClaimRecord[];
  totalClaims: number;
  statusCounts: DashboardStatusCounts;
  staleProcessingCount: number;
  nextCursor: string | null;
  prevCursor: string | null;
};

const DEFAULT_DASHBOARD_PAGE_SIZE = 100;

const dashboardOrderByDesc: Prisma.ClaimOrderByWithRelationInput[] = [
  { createdAt: "desc" },
  { id: "desc" },
];

const dashboardOrderByAsc: Prisma.ClaimOrderByWithRelationInput[] = [
  { createdAt: "asc" },
  { id: "asc" },
];

export async function listDashboardClaims(input: {
  organizationId: string;
  filters: ClaimFilters;
  cursor: TimestampCursor | null;
  direction: PageDirection;
  pageSize?: number;
}): Promise<DashboardClaimsPage> {
  const pageSize = input.pageSize ?? DEFAULT_DASHBOARD_PAGE_SIZE;
  const staleProcessingBefore = getClaimProcessingStaleBefore();

  const [claimsWindow, groupedCounts, staleProcessingCount] = await Promise.all([
    prisma.claim.findMany({
      where: applyTimestampCursor(
        buildClaimWhereInput(input.organizationId, input.filters),
        input.cursor,
        input.direction,
        "createdAt",
      ),
      orderBy: input.direction === "prev" ? dashboardOrderByAsc : dashboardOrderByDesc,
      take: pageSize + 1,
      select: {
        id: true,
        externalClaimId: true,
        customerName: true,
        productName: true,
        status: true,
        warrantyStatus: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.claim.groupBy({
      by: ["status"],
      where: {
        organizationId: input.organizationId,
      },
      _count: {
        _all: true,
      },
    }),
    prisma.claim.count({
      where: {
        organizationId: input.organizationId,
        status: "PROCESSING",
        updatedAt: {
          lte: staleProcessingBefore,
        },
      },
    }),
  ]);

  const statusCounts = Object.fromEntries(
    CLAIM_STATUSES.map((status) => [status, 0]),
  ) as DashboardStatusCounts;

  for (const entry of groupedCounts) {
    statusCounts[entry.status] = entry._count._all;
  }

  const totalClaims = groupedCounts.reduce((sum, entry) => sum + entry._count._all, 0);
  const hasMoreInDirection = claimsWindow.length > pageSize;
  const pageSlice = hasMoreInDirection ? claimsWindow.slice(0, pageSize) : claimsWindow;
  const claims = input.direction === "prev" ? [...pageSlice].reverse() : pageSlice;
  const first = claims[0] ?? null;
  const last = claims[claims.length - 1] ?? null;

  const nextCursor = last
    ? input.direction === "prev"
      ? encodeTimestampCursor({ timestamp: last.createdAt, id: last.id })
      : hasMoreInDirection
        ? encodeTimestampCursor({ timestamp: last.createdAt, id: last.id })
        : null
    : null;

  const prevCursor = first
    ? input.direction === "prev"
      ? hasMoreInDirection
        ? encodeTimestampCursor({ timestamp: first.createdAt, id: first.id })
        : null
      : input.cursor
        ? encodeTimestampCursor({ timestamp: first.createdAt, id: first.id })
        : null
    : null;

  return {
    claims: claims.map((claim) => ({
      ...claim,
      isProcessingStale: isClaimProcessingStale(claim.status, claim.updatedAt),
    })),
    totalClaims,
    statusCounts,
    staleProcessingCount,
    nextCursor,
    prevCursor,
  };
}
