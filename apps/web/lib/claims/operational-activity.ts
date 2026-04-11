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
  const counts = await loadClaimStatusTransitionCounts(input.organizationId, activitySince);

  return {
    windowHours: CLAIM_OPERATIONAL_ACTIVITY_WINDOW_HOURS,
    watchdogRecoveryCount: counts.watchdogRecoveryCount,
    manualProcessingRecoveryCount: counts.manualProcessingRecoveryCount,
    manualRetryCount: counts.manualRetryCount,
  };
}

const CLAIM_OPERATIONAL_ACTIVITY_SOURCES = [
  CLAIM_PROCESSING_RECOVERY_SOURCES.watchdogProcessingRecovery,
  CLAIM_PROCESSING_RECOVERY_SOURCES.manualProcessingRecovery,
  CLAIM_PROCESSING_START_SOURCES.manualRetry,
] as const;

type ClaimOperationalActivityCountsRow = {
  watchdogRecoveryCount: number;
  manualProcessingRecoveryCount: number;
  manualRetryCount: number;
};

async function loadClaimStatusTransitionCounts(
  organizationId: string | undefined,
  activitySince: Date,
): Promise<ClaimOperationalActivityCountsRow> {
  const rows = await prisma.$queryRaw<Array<ClaimOperationalActivityCountsRow>>(Prisma.sql`
    SELECT
      COUNT(*) FILTER (
        WHERE payload->>'source' = ${CLAIM_PROCESSING_RECOVERY_SOURCES.watchdogProcessingRecovery}
      )::int AS "watchdogRecoveryCount",
      COUNT(*) FILTER (
        WHERE payload->>'source' = ${CLAIM_PROCESSING_RECOVERY_SOURCES.manualProcessingRecovery}
      )::int AS "manualProcessingRecoveryCount",
      COUNT(*) FILTER (
        WHERE payload->>'source' = ${CLAIM_PROCESSING_START_SOURCES.manualRetry}
      )::int AS "manualRetryCount"
    FROM "ClaimEvent"
    WHERE "eventType" = 'STATUS_TRANSITION'
      AND "createdAt" >= ${activitySince}
      ${organizationId ? Prisma.sql`AND "organizationId" = ${organizationId}` : Prisma.empty}
      AND payload->>'source' IN (${Prisma.join(CLAIM_OPERATIONAL_ACTIVITY_SOURCES)})
  `);

  return (
    rows[0] ?? {
      watchdogRecoveryCount: 0,
      manualProcessingRecoveryCount: 0,
      manualRetryCount: 0,
    }
  );
}
