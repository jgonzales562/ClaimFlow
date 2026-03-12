import {
  prisma,
  CLAIM_PROCESSING_RECOVERY_SOURCES,
  CLAIM_PROCESSING_START_SOURCES,
} from "@claimflow/db";
import { Prisma } from "@prisma/client";

export type ClaimOperationalActivity = {
  windowHours: number;
  watchdogRecoveryCount: number;
  manualProcessingRecoveryCount: number;
  manualRetryCount: number;
};

export const CLAIM_OPERATIONAL_ACTIVITY_WINDOW_HOURS = 24;

export async function loadClaimOperationalActivity(input: {
  organizationId?: string;
  now?: Date;
} = {}): Promise<ClaimOperationalActivity> {
  const now = input.now ?? new Date();
  const activitySince = new Date(
    now.getTime() - CLAIM_OPERATIONAL_ACTIVITY_WINDOW_HOURS * 60 * 60 * 1000,
  );
  const countsBySource = await loadClaimStatusTransitionCountsBySource(
    input.organizationId,
    activitySince,
  );

  return {
    windowHours: CLAIM_OPERATIONAL_ACTIVITY_WINDOW_HOURS,
    watchdogRecoveryCount:
      countsBySource[CLAIM_PROCESSING_RECOVERY_SOURCES.watchdogProcessingRecovery] ?? 0,
    manualProcessingRecoveryCount:
      countsBySource[CLAIM_PROCESSING_RECOVERY_SOURCES.manualProcessingRecovery] ?? 0,
    manualRetryCount: countsBySource[CLAIM_PROCESSING_START_SOURCES.manualRetry] ?? 0,
  };
}

const CLAIM_OPERATIONAL_ACTIVITY_SOURCES = [
  CLAIM_PROCESSING_RECOVERY_SOURCES.watchdogProcessingRecovery,
  CLAIM_PROCESSING_RECOVERY_SOURCES.manualProcessingRecovery,
  CLAIM_PROCESSING_START_SOURCES.manualRetry,
] as const;

type ClaimOperationalActivitySource =
  (typeof CLAIM_OPERATIONAL_ACTIVITY_SOURCES)[number];

async function loadClaimStatusTransitionCountsBySource(
  organizationId: string | undefined,
  activitySince: Date,
): Promise<Partial<Record<ClaimOperationalActivitySource, number>>> {
  const rows = await prisma.$queryRaw<Array<{ source: string; count: number }>>(Prisma.sql`
    SELECT
      payload->>'source' AS source,
      COUNT(*)::int AS count
    FROM "ClaimEvent"
    WHERE "eventType" = 'STATUS_TRANSITION'
      AND "createdAt" >= ${activitySince}
      ${organizationId ? Prisma.sql`AND "organizationId" = ${organizationId}` : Prisma.empty}
      AND payload->>'source' IN (${Prisma.join(CLAIM_OPERATIONAL_ACTIVITY_SOURCES)})
    GROUP BY payload->>'source'
  `);

  return Object.fromEntries(
    rows.map((row) => [row.source as ClaimOperationalActivitySource, row.count]),
  );
}
