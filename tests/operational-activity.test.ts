import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../packages/db/src/index.ts";
import { loadClaimOperationalActivity } from "../apps/web/lib/claims/operational-activity.ts";

after(async () => {
  await prisma.$disconnect();
});

test("claim operational activity counts only recent tracked status-transition sources per organization", async () => {
  const firstFixture = await createOperationalActivityFixture("alpha");
  const secondFixture = await createOperationalActivityFixture("beta");
  const now = new Date("2026-04-04T18:00:00.000Z");

  try {
    await createOperationalActivityEvent({
      organizationId: firstFixture.organizationId,
      claimId: firstFixture.claimId,
      source: "watchdog_processing_recovery",
      createdAt: new Date("2026-04-04T17:30:00.000Z"),
    });
    await createOperationalActivityEvent({
      organizationId: firstFixture.organizationId,
      claimId: firstFixture.claimId,
      source: "manual_processing_recovery",
      createdAt: new Date("2026-04-04T17:00:00.000Z"),
    });
    await createOperationalActivityEvent({
      organizationId: firstFixture.organizationId,
      claimId: firstFixture.claimId,
      source: "manual_retry",
      createdAt: new Date("2026-04-04T16:30:00.000Z"),
    });
    await createOperationalActivityEvent({
      organizationId: firstFixture.organizationId,
      claimId: firstFixture.claimId,
      source: "queue_replay",
      createdAt: new Date("2026-04-04T16:00:00.000Z"),
    });
    await prisma.claimEvent.create({
      data: {
        organizationId: firstFixture.organizationId,
        claimId: firstFixture.claimId,
        eventType: "MANUAL_EDIT",
        payload: {
          source: "manual_retry",
        },
        createdAt: new Date("2026-04-04T15:30:00.000Z"),
      },
    });
    await createOperationalActivityEvent({
      organizationId: secondFixture.organizationId,
      claimId: secondFixture.claimId,
      source: "manual_retry",
      createdAt: new Date("2026-04-04T15:00:00.000Z"),
    });

    const result = await loadClaimOperationalActivity({
      organizationId: firstFixture.organizationId,
      now,
    });

    assert.deepEqual(result, {
      windowHours: 24,
      watchdogRecoveryCount: 1,
      manualProcessingRecoveryCount: 1,
      manualRetryCount: 1,
    });
  } finally {
    await Promise.all([firstFixture.cleanup(), secondFixture.cleanup()]);
  }
});

async function createOperationalActivityFixture(label: string) {
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: {
      name: `Operational Activity ${label} ${suffix}`,
      slug: `operational-activity-${label}-${suffix}`,
      claims: {
        create: {
          externalClaimId: `operational-activity-claim-${suffix}`,
          sourceEmail: `operational-activity-${suffix}@example.com`,
          issueSummary: "Operational activity test claim",
          status: "READY",
        },
      },
    },
    select: {
      id: true,
      claims: {
        select: {
          id: true,
        },
        take: 1,
      },
    },
  });

  return {
    organizationId: organization.id,
    claimId: readRequiredClaimId(organization.claims[0]?.id),
    cleanup: async () => {
      await prisma.organization.delete({
        where: {
          id: organization.id,
        },
      });
    },
  };
}

async function createOperationalActivityEvent(input: {
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

function readRequiredClaimId(value: string | undefined): string {
  if (!value) {
    throw new Error("Expected the operational activity fixture to create a claim.");
  }

  return value;
}
