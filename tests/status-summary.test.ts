import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../packages/db/src/index.ts";
import { loadClaimStatusSummary } from "../apps/web/lib/claims/status-summary.ts";

after(async () => {
  await prisma.$disconnect();
});

test("claim status summary tracks inserts, transitions, deletions, and stale processing per organization", async () => {
  const fixture = await createStatusSummaryFixture();
  const staleProcessingBefore = new Date("2026-04-05T12:00:00.000Z");

  try {
    const newClaim = await prisma.claim.create({
      data: {
        organizationId: fixture.organizationId,
        externalClaimId: `status-summary-new-${randomUUID()}`,
        sourceEmail: `status-summary-new-${randomUUID()}@example.com`,
        issueSummary: "New summary claim",
        status: "NEW",
      },
      select: {
        id: true,
      },
    });
    const staleProcessingClaim = await prisma.claim.create({
      data: {
        organizationId: fixture.organizationId,
        externalClaimId: `status-summary-processing-stale-${randomUUID()}`,
        sourceEmail: `status-summary-processing-stale-${randomUUID()}@example.com`,
        issueSummary: "Stale processing summary claim",
        status: "PROCESSING",
      },
      select: {
        id: true,
      },
    });
    const freshProcessingClaim = await prisma.claim.create({
      data: {
        organizationId: fixture.organizationId,
        externalClaimId: `status-summary-processing-fresh-${randomUUID()}`,
        sourceEmail: `status-summary-processing-fresh-${randomUUID()}@example.com`,
        issueSummary: "Fresh processing summary claim",
        status: "PROCESSING",
      },
      select: {
        id: true,
      },
    });
    const readyClaim = await prisma.claim.create({
      data: {
        organizationId: fixture.organizationId,
        externalClaimId: `status-summary-ready-${randomUUID()}`,
        sourceEmail: `status-summary-ready-${randomUUID()}@example.com`,
        issueSummary: "Ready summary claim",
        status: "READY",
      },
      select: {
        id: true,
      },
    });

    await prisma.$executeRaw`
      UPDATE "Claim"
      SET "updatedAt" = ${new Date("2026-04-05T11:15:00.000Z")}
      WHERE id = ${staleProcessingClaim.id}
    `;
    await prisma.$executeRaw`
      UPDATE "Claim"
      SET "updatedAt" = ${new Date("2026-04-05T12:15:00.000Z")}
      WHERE id = ${freshProcessingClaim.id}
    `;

    const initialSummary = await loadClaimStatusSummary({
      organizationId: fixture.organizationId,
      staleProcessingBefore,
    });

    assert.deepEqual(initialSummary.statusCounts, {
      NEW: 1,
      PROCESSING: 2,
      REVIEW_REQUIRED: 0,
      READY: 1,
      ERROR: 0,
    });
    assert.equal(initialSummary.totalClaims, 4);
    assert.equal(initialSummary.staleProcessingCount, 1);
    assert.equal(initialSummary.staleProcessingOrganizationCount, 1);

    await prisma.claim.update({
      where: {
        id: readyClaim.id,
      },
      data: {
        status: "ERROR",
      },
    });
    await prisma.claim.update({
      where: {
        id: freshProcessingClaim.id,
      },
      data: {
        status: "READY",
      },
    });
    await prisma.claim.delete({
      where: {
        id: newClaim.id,
      },
    });

    const updatedSummary = await loadClaimStatusSummary({
      organizationId: fixture.organizationId,
      staleProcessingBefore,
    });

    assert.deepEqual(updatedSummary.statusCounts, {
      NEW: 0,
      PROCESSING: 1,
      REVIEW_REQUIRED: 0,
      READY: 1,
      ERROR: 1,
    });
    assert.equal(updatedSummary.totalClaims, 3);
    assert.equal(updatedSummary.staleProcessingCount, 1);
    assert.equal(updatedSummary.staleProcessingOrganizationCount, 1);

    await prisma.claim.update({
      where: {
        id: staleProcessingClaim.id,
      },
      data: {
        status: "READY",
      },
    });

    const settledSummary = await loadClaimStatusSummary({
      organizationId: fixture.organizationId,
      staleProcessingBefore,
    });

    assert.deepEqual(settledSummary.statusCounts, {
      NEW: 0,
      PROCESSING: 0,
      REVIEW_REQUIRED: 0,
      READY: 2,
      ERROR: 1,
    });
    assert.equal(settledSummary.totalClaims, 3);
    assert.equal(settledSummary.staleProcessingCount, 0);
    assert.equal(settledSummary.staleProcessingOrganizationCount, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("claim status summary returns zeros for organizations without claims", async () => {
  const fixture = await createStatusSummaryFixture();

  try {
    const summary = await loadClaimStatusSummary({
      organizationId: fixture.organizationId,
      staleProcessingBefore: new Date("2026-04-05T12:00:00.000Z"),
    });

    assert.deepEqual(summary.statusCounts, {
      NEW: 0,
      PROCESSING: 0,
      REVIEW_REQUIRED: 0,
      READY: 0,
      ERROR: 0,
    });
    assert.equal(summary.totalClaims, 0);
    assert.equal(summary.staleProcessingCount, 0);
    assert.equal(summary.staleProcessingOrganizationCount, 0);
  } finally {
    await fixture.cleanup();
  }
});

async function createStatusSummaryFixture() {
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: {
      name: `Status Summary Test ${suffix}`,
      slug: `status-summary-test-${suffix}`,
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
