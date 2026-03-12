import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../packages/db/src/index.ts";
import { loadClaimsOperationsHealthSnapshot } from "../apps/web/lib/claims/operations-health.ts";

after(async () => {
  await prisma.$disconnect();
});

test("claims operations health aggregates stale processing and recent recovery activity", async () => {
  const firstOrg = await createOperationsHealthFixture("alpha");
  const secondOrg = await createOperationsHealthFixture("beta");
  const now = new Date("2026-03-11T18:00:00.000Z");
  const baseline = await loadClaimsOperationsHealthSnapshot({ now });

  try {
    const firstReadyClaim = await createHealthClaim({
      organizationId: firstOrg.organizationId,
      status: "READY",
      updatedAt: new Date("2026-03-11T10:00:00.000Z"),
    });
    const firstStaleProcessingClaim = await createHealthClaim({
      organizationId: firstOrg.organizationId,
      status: "PROCESSING",
      updatedAt: new Date("2026-03-11T17:20:00.000Z"),
    });
    await createHealthClaim({
      organizationId: firstOrg.organizationId,
      status: "PROCESSING",
      updatedAt: new Date("2026-03-11T17:45:00.000Z"),
    });
    await createHealthClaim({
      organizationId: firstOrg.organizationId,
      status: "ERROR",
      updatedAt: new Date("2026-03-11T09:00:00.000Z"),
    });

    const secondReviewClaim = await createHealthClaim({
      organizationId: secondOrg.organizationId,
      status: "REVIEW_REQUIRED",
      updatedAt: new Date("2026-03-11T11:00:00.000Z"),
    });
    await createHealthClaim({
      organizationId: secondOrg.organizationId,
      status: "PROCESSING",
      updatedAt: new Date("2026-03-11T17:00:00.000Z"),
    });
    await createHealthClaim({
      organizationId: secondOrg.organizationId,
      status: "NEW",
      updatedAt: new Date("2026-03-11T08:00:00.000Z"),
    });

    await createHealthEvent({
      organizationId: firstOrg.organizationId,
      claimId: firstReadyClaim.id,
      source: "watchdog_processing_recovery",
      createdAt: new Date("2026-03-11T17:00:00.000Z"),
    });
    await createHealthEvent({
      organizationId: secondOrg.organizationId,
      claimId: secondReviewClaim.id,
      source: "manual_processing_recovery",
      createdAt: new Date("2026-03-11T16:30:00.000Z"),
    });
    await createHealthEvent({
      organizationId: firstOrg.organizationId,
      claimId: firstStaleProcessingClaim.id,
      source: "manual_retry",
      createdAt: new Date("2026-03-11T15:00:00.000Z"),
    });
    await createHealthEvent({
      organizationId: firstOrg.organizationId,
      claimId: firstReadyClaim.id,
      source: "manual_retry",
      createdAt: new Date("2026-03-09T16:59:59.000Z"),
    });
    await prisma.claimEvent.create({
      data: {
        organizationId: firstOrg.organizationId,
        claimId: firstReadyClaim.id,
        eventType: "MANUAL_EDIT",
        payload: {
          field: "customerName",
        },
        createdAt: new Date("2026-03-11T17:10:00.000Z"),
      },
    });

    const snapshot = await loadClaimsOperationsHealthSnapshot({ now });

    assert.equal(snapshot.totalClaims, baseline.totalClaims + 7);
    assert.deepEqual(snapshot.statusCounts, {
      NEW: baseline.statusCounts.NEW + 1,
      PROCESSING: baseline.statusCounts.PROCESSING + 3,
      REVIEW_REQUIRED: baseline.statusCounts.REVIEW_REQUIRED + 1,
      READY: baseline.statusCounts.READY + 1,
      ERROR: baseline.statusCounts.ERROR + 1,
    });
    assert.equal(snapshot.staleProcessingCount, baseline.staleProcessingCount + 2);
    assert.equal(
      snapshot.staleProcessingOrganizationCount,
      baseline.staleProcessingOrganizationCount + 2,
    );
    assert.deepEqual(snapshot.operationalActivity, {
      windowHours: 24,
      watchdogRecoveryCount: baseline.operationalActivity.watchdogRecoveryCount + 1,
      manualProcessingRecoveryCount:
        baseline.operationalActivity.manualProcessingRecoveryCount + 1,
      manualRetryCount: baseline.operationalActivity.manualRetryCount + 1,
    });
  } finally {
    await Promise.all([firstOrg.cleanup(), secondOrg.cleanup()]);
  }
});

async function createOperationsHealthFixture(label: string) {
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: {
      name: `Operations Health ${label} ${suffix}`,
      slug: `operations-health-${label}-${suffix}`,
    },
    select: {
      id: true,
    },
  });

  return {
    organizationId: organization.id,
    cleanup: async () => {
      await prisma.organization.delete({
        where: {
          id: organization.id,
        },
      });
    },
  };
}

async function createHealthClaim(input: {
  organizationId: string;
  status: "NEW" | "PROCESSING" | "REVIEW_REQUIRED" | "READY" | "ERROR";
  updatedAt: Date;
}) {
  const claim = await prisma.claim.create({
    data: {
      organizationId: input.organizationId,
      externalClaimId: `ops-health-claim-${randomUUID()}`,
      status: input.status,
    },
    select: {
      id: true,
    },
  });

  await prisma.$executeRaw`
    UPDATE "Claim"
    SET "updatedAt" = ${input.updatedAt}
    WHERE id = ${claim.id}
  `;

  return claim;
}

async function createHealthEvent(input: {
  organizationId: string;
  claimId: string;
  source: string;
  createdAt: Date;
}) {
  return prisma.claimEvent.create({
    data: {
      organizationId: input.organizationId,
      claimId: input.claimId,
      eventType: "STATUS_TRANSITION",
      payload: {
        source: input.source,
      },
      createdAt: input.createdAt,
    },
  });
}
