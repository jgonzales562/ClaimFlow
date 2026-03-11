import { prisma } from "@claimflow/db";
import { CLAIM_STATUSES, type ClaimStatus } from "./filters";
import { type DashboardOperationalActivity } from "./dashboard-claims";
import { loadClaimOperationalActivity } from "./operational-activity";
import { getClaimProcessingStaleBefore, getClaimProcessingStaleMinutes } from "./processing-health";

export type ClaimsOperationsHealthSnapshot = {
  totalClaims: number;
  statusCounts: Record<ClaimStatus, number>;
  staleProcessingCount: number;
  staleProcessingOrganizationCount: number;
  operationalActivity: DashboardOperationalActivity;
};

const DEFAULT_MAX_STALE_PROCESSING_COUNT = 0;

export async function loadClaimsOperationsHealthSnapshot(input: {
  now?: Date;
} = {}): Promise<ClaimsOperationsHealthSnapshot> {
  const now = input.now ?? new Date();
  const staleProcessingBefore = getClaimProcessingStaleBefore(now);

  const [
    groupedCounts,
    staleProcessingGroups,
    operationalActivity,
  ] = await Promise.all([
    prisma.claim.groupBy({
      by: ["status"],
      _count: {
        _all: true,
      },
    }),
    prisma.claim.groupBy({
      by: ["organizationId"],
      where: {
        status: "PROCESSING",
        updatedAt: {
          lte: staleProcessingBefore,
        },
      },
      _count: {
        _all: true,
      },
    }),
    loadClaimOperationalActivity({
      now,
    }),
  ]);

  const statusCounts = Object.fromEntries(
    CLAIM_STATUSES.map((status) => [status, 0]),
  ) as Record<ClaimStatus, number>;

  for (const entry of groupedCounts) {
    statusCounts[entry.status] = entry._count._all;
  }

  return {
    totalClaims: groupedCounts.reduce((sum, entry) => sum + entry._count._all, 0),
    statusCounts,
    staleProcessingCount: staleProcessingGroups.reduce(
      (sum, entry) => sum + entry._count._all,
      0,
    ),
    staleProcessingOrganizationCount: staleProcessingGroups.length,
    operationalActivity,
  };
}

export function getClaimsHealthMaxStaleProcessingCount(): number {
  const raw = process.env.CLAIMS_HEALTH_MAX_STALE_PROCESSING_COUNT?.trim();
  if (!raw) {
    return DEFAULT_MAX_STALE_PROCESSING_COUNT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000) {
    throw new Error(
      "CLAIMS_HEALTH_MAX_STALE_PROCESSING_COUNT must be an integer between 0 and 1000000.",
    );
  }

  return parsed;
}

export function getClaimsHealthBearerToken(): string | null {
  const token = process.env.CLAIMS_HEALTH_BEARER_TOKEN?.trim();
  return token ? token : null;
}

export function isClaimsProcessingWatchdogEnabled(): boolean {
  const raw = process.env.CLAIMS_PROCESSING_WATCHDOG_ENABLED?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

export function getClaimsHealthStaleMinutes(): number {
  return getClaimProcessingStaleMinutes();
}
