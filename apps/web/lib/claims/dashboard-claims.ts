import { loadClaimIngestQueueOutboxSummary, prisma } from "@claimflow/db";
import type { Prisma } from "@prisma/client";
import {
  applyTimestampCursor,
  encodeTimestampCursor,
  type PageDirection,
  type TimestampCursor,
} from "./cursor-pagination";
import {
  buildClaimWhereInput,
  type ClaimFilters,
  type ClaimStatus,
} from "./filters";
import { loadClaimOperationalActivity, type ClaimOperationalActivity } from "./operational-activity";
import { getClaimProcessingStaleBefore, isClaimProcessingStale } from "./processing-health";
import { loadClaimStatusSummary } from "./status-summary";

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

export type DashboardOperationalActivity = ClaimOperationalActivity;

export type DashboardOperationalSummary = {
  totalClaims: number;
  statusCounts: DashboardStatusCounts;
  staleProcessingCount: number;
  operationalActivity: DashboardOperationalActivity;
  ingestQueueOutbox: {
    pendingCount: number;
    dueCount: number;
    oldestPendingAgeMinutes: number | null;
    oldestPendingCreatedAt: Date | null;
    oldestDueAgeMinutes: number | null;
    oldestDueAvailableAt: Date | null;
  };
};

export type DashboardClaimsPage = DashboardOperationalSummary & {
  claims: DashboardClaimRecord[];
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
  now?: Date;
}): Promise<DashboardClaimsPage> {
  const pageSize = input.pageSize ?? DEFAULT_DASHBOARD_PAGE_SIZE;
  const now = input.now ?? new Date();

  const [
    claimsWindow,
    operationalSummary,
  ] = await Promise.all([
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
    loadDashboardOperationalSummary({
      organizationId: input.organizationId,
      now,
    }),
  ]);
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
    ...operationalSummary,
    claims: claims.map((claim) => ({
      ...claim,
      isProcessingStale: isClaimProcessingStale(claim.status, claim.updatedAt),
    })),
    nextCursor,
    prevCursor,
  };
}

export async function loadDashboardOperationalSummary(input: {
  organizationId: string;
  now?: Date;
}): Promise<DashboardOperationalSummary> {
  const now = input.now ?? new Date();
  const staleProcessingBefore = getClaimProcessingStaleBefore(now);

  const [
    statusSummary,
    operationalActivity,
    ingestQueueOutbox,
  ] = await Promise.all([
    loadClaimStatusSummary({
      organizationId: input.organizationId,
      staleProcessingBefore,
    }),
    loadClaimOperationalActivity({
      organizationId: input.organizationId,
      now,
    }),
    loadClaimIngestQueueOutboxSummary({
      prismaClient: prisma,
      organizationId: input.organizationId,
      now,
    }),
  ]);

  return {
    totalClaims: statusSummary.totalClaims,
    statusCounts: statusSummary.statusCounts,
    staleProcessingCount: statusSummary.staleProcessingCount,
    operationalActivity,
    ingestQueueOutbox,
  };
}
