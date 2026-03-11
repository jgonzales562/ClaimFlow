import {
  prisma,
  CLAIM_PROCESSING_RECOVERY_SOURCES,
  CLAIM_PROCESSING_START_SOURCES,
} from "@claimflow/db";
import type { Prisma } from "@prisma/client";

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

  const [
    watchdogRecoveryCount,
    manualProcessingRecoveryCount,
    manualRetryCount,
  ] = await Promise.all([
    countClaimStatusTransitions(
      CLAIM_PROCESSING_RECOVERY_SOURCES.watchdogProcessingRecovery,
      input.organizationId,
      activitySince,
    ),
    countClaimStatusTransitions(
      CLAIM_PROCESSING_RECOVERY_SOURCES.manualProcessingRecovery,
      input.organizationId,
      activitySince,
    ),
    countClaimStatusTransitions(
      CLAIM_PROCESSING_START_SOURCES.manualRetry,
      input.organizationId,
      activitySince,
    ),
  ]);

  return {
    windowHours: CLAIM_OPERATIONAL_ACTIVITY_WINDOW_HOURS,
    watchdogRecoveryCount,
    manualProcessingRecoveryCount,
    manualRetryCount,
  };
}

async function countClaimStatusTransitions(
  source:
    | (typeof CLAIM_PROCESSING_RECOVERY_SOURCES)[keyof typeof CLAIM_PROCESSING_RECOVERY_SOURCES]
    | (typeof CLAIM_PROCESSING_START_SOURCES)[keyof typeof CLAIM_PROCESSING_START_SOURCES],
  organizationId: string | undefined,
  activitySince: Date,
) {
  const where: Prisma.ClaimEventWhereInput = {
    ...(organizationId ? { organizationId } : {}),
    eventType: "STATUS_TRANSITION",
    createdAt: {
      gte: activitySince,
    },
    payload: {
      path: ["source"],
      equals: source,
    },
  };

  return prisma.claimEvent.count({ where });
}
