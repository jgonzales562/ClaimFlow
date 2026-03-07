import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../packages/db/src/index.ts";
import {
  listDashboardClaims,
} from "../apps/web/lib/claims/dashboard-claims.ts";
import { parseTimestampCursor } from "../apps/web/lib/claims/cursor-pagination.ts";

after(async () => {
  await prisma.$disconnect();
});

test("dashboard claims returns organization-wide status counts and filtered rows", async () => {
  const { organizationId, cleanup } = await createDashboardClaimsFixture();
  const now = new Date("2026-02-05T12:00:00.000Z");

  try {
    const newestMatching = await createDashboardClaim({
      organizationId,
      externalClaimId: "dashboard-claim-a",
      productName: "Blender Ultra",
      status: "READY",
      createdAt: new Date("2026-02-03T12:00:00.000Z"),
    });

    await createDashboardClaim({
      organizationId,
      externalClaimId: "dashboard-claim-b",
      productName: "Blender Compact",
      status: "ERROR",
      createdAt: new Date("2026-02-02T12:00:00.000Z"),
    });

    await createDashboardClaim({
      organizationId,
      externalClaimId: "dashboard-claim-c",
      productName: "Toaster Prime",
      status: "REVIEW_REQUIRED",
      createdAt: new Date("2026-02-01T12:00:00.000Z"),
    });

    await createDashboardClaim({
      organizationId,
      externalClaimId: "dashboard-claim-d",
      productName: "Microwave Basic",
      status: "NEW",
      createdAt: new Date("2026-01-31T12:00:00.000Z"),
    });

    const otherOrganization = await createDashboardClaimsFixture();
    try {
      await createDashboardClaim({
        organizationId: otherOrganization.organizationId,
        externalClaimId: "dashboard-claim-other",
        productName: "Blender Hidden",
        status: "PROCESSING",
        createdAt: new Date("2026-02-04T12:00:00.000Z"),
        updatedAt: new Date("2026-02-04T12:00:00.000Z"),
      });

      await createDashboardClaimEvent({
        organizationId,
        claimId: newestMatching.id,
        createdAt: new Date("2026-02-05T09:00:00.000Z"),
        source: "manual_retry",
      });
      await createDashboardClaimEvent({
        organizationId,
        claimId: newestMatching.id,
        createdAt: new Date("2026-02-05T08:00:00.000Z"),
        source: "manual_processing_recovery",
      });
      await createDashboardClaimEvent({
        organizationId,
        claimId: newestMatching.id,
        createdAt: new Date("2026-02-05T07:00:00.000Z"),
        source: "watchdog_processing_recovery",
      });
      await createDashboardClaimEvent({
        organizationId,
        claimId: newestMatching.id,
        createdAt: new Date("2026-02-03T06:00:00.000Z"),
        source: "manual_retry",
      });
      await createDashboardClaimEvent({
        organizationId: otherOrganization.organizationId,
        claimId: "missing-claim-id",
        createdAt: new Date("2026-02-05T07:30:00.000Z"),
        source: "watchdog_processing_recovery",
        createDetached: true,
      });

      const result = await listDashboardClaims({
        organizationId,
        filters: {
          status: null,
          search: "blender",
          createdFrom: null,
          createdTo: null,
        },
        cursor: null,
        direction: "next",
        pageSize: 10,
        now,
      });

      assert.equal(result.totalClaims, 4);
      assert.deepEqual(result.statusCounts, {
        NEW: 1,
        PROCESSING: 0,
        REVIEW_REQUIRED: 1,
        READY: 1,
        ERROR: 1,
      });
      assert.equal(result.staleProcessingCount, 0);
      assert.deepEqual(result.operationalActivity, {
        windowHours: 24,
        watchdogRecoveryCount: 1,
        manualProcessingRecoveryCount: 1,
        manualRetryCount: 1,
      });
      assert.deepEqual(
        result.claims.map((claim) => claim.externalClaimId),
        [newestMatching.externalClaimId, "dashboard-claim-b"],
      );
      assert.equal(result.nextCursor, null);
      assert.equal(result.prevCursor, null);
    } finally {
      await otherOrganization.cleanup();
    }
  } finally {
    await cleanup();
  }
});

test("dashboard claims paginates forward and backward with created-at cursors", async () => {
  const { organizationId, cleanup } = await createDashboardClaimsFixture();
  const now = new Date("2026-03-03T13:00:00.000Z");

  try {
    const newest = await createDashboardClaim({
      organizationId,
      externalClaimId: "dashboard-page-newest",
      productName: "Newest Product",
      status: "READY",
      createdAt: new Date("2026-03-03T12:00:00.000Z"),
    });

    const middle = await createDashboardClaim({
      organizationId,
      externalClaimId: "dashboard-page-middle",
      productName: "Middle Product",
      status: "PROCESSING",
      createdAt: new Date("2026-03-02T12:00:00.000Z"),
      updatedAt: new Date("2026-01-01T12:00:00.000Z"),
    });

    const oldest = await createDashboardClaim({
      organizationId,
      externalClaimId: "dashboard-page-oldest",
      productName: "Oldest Product",
      status: "NEW",
      createdAt: new Date("2026-03-01T12:00:00.000Z"),
    });

    const firstPage = await listDashboardClaims({
      organizationId,
      filters: {
        status: null,
        search: null,
        createdFrom: null,
        createdTo: null,
      },
      cursor: null,
      direction: "next",
      pageSize: 2,
      now,
    });

    assert.equal(firstPage.totalClaims, 3);
    assert.equal(firstPage.staleProcessingCount, 1);
    assert.deepEqual(
      firstPage.claims.map((claim) => claim.externalClaimId),
      [newest.externalClaimId, middle.externalClaimId],
    );
    assert.equal(firstPage.claims[1]?.isProcessingStale, true);
    assert.notEqual(firstPage.nextCursor, null);
    assert.equal(firstPage.prevCursor, null);
    if (!firstPage.nextCursor) {
      throw new Error("Expected a next cursor for the first dashboard page.");
    }

    const secondPage = await listDashboardClaims({
      organizationId,
      filters: {
        status: null,
        search: null,
        createdFrom: null,
        createdTo: null,
      },
      cursor: parseTimestampCursor(firstPage.nextCursor),
      direction: "next",
      pageSize: 2,
      now,
    });

    assert.equal(secondPage.totalClaims, 3);
    assert.deepEqual(
      secondPage.claims.map((claim) => claim.externalClaimId),
      [oldest.externalClaimId],
    );
    assert.equal(secondPage.nextCursor, null);
    assert.notEqual(secondPage.prevCursor, null);
    if (!secondPage.prevCursor) {
      throw new Error("Expected a previous cursor for the second dashboard page.");
    }

    const previousPage = await listDashboardClaims({
      organizationId,
      filters: {
        status: null,
        search: null,
        createdFrom: null,
        createdTo: null,
      },
      cursor: parseTimestampCursor(secondPage.prevCursor),
      direction: "prev",
      pageSize: 2,
      now,
    });

    assert.equal(previousPage.totalClaims, 3);
    assert.deepEqual(
      previousPage.claims.map((claim) => claim.externalClaimId),
      [newest.externalClaimId, middle.externalClaimId],
    );
  } finally {
    await cleanup();
  }
});

async function createDashboardClaimsFixture() {
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: {
      name: `Dashboard Claims Test ${suffix}`,
      slug: `dashboard-claims-test-${suffix}`,
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

async function createDashboardClaim(input: {
  organizationId: string;
  externalClaimId: string;
  productName: string;
  status: "NEW" | "PROCESSING" | "REVIEW_REQUIRED" | "READY" | "ERROR";
  createdAt: Date;
  updatedAt?: Date;
}) {
  const claim = await prisma.claim.create({
    data: {
      organizationId: input.organizationId,
      externalClaimId: input.externalClaimId,
      sourceEmail: `${input.externalClaimId}@example.com`,
      customerName: `Customer ${input.externalClaimId}`,
      productName: input.productName,
      issueSummary: `Issue for ${input.externalClaimId}`,
      status: input.status,
    },
    select: {
      id: true,
      externalClaimId: true,
    },
  });

  await prisma.$executeRaw`
    UPDATE "Claim"
    SET "createdAt" = ${input.createdAt}
    WHERE "id" = ${claim.id}
  `;

  if (input.updatedAt) {
    await prisma.$executeRaw`
      UPDATE "Claim"
      SET "updatedAt" = ${input.updatedAt}
      WHERE "id" = ${claim.id}
    `;
  }

  return claim;
}

async function createDashboardClaimEvent(input: {
  organizationId: string;
  claimId: string;
  createdAt: Date;
  source: "manual_retry" | "manual_processing_recovery" | "watchdog_processing_recovery";
  createDetached?: boolean;
}) {
  const event = await prisma.claimEvent.create({
    data: {
      organizationId: input.organizationId,
      claimId: input.createDetached ? await createDetachedClaim(input.organizationId) : input.claimId,
      eventType: "STATUS_TRANSITION",
      payload: {
        fromStatus: "PROCESSING",
        toStatus: "PROCESSING",
        source: input.source,
      },
    },
    select: {
      id: true,
    },
  });

  await prisma.$executeRaw`
    UPDATE "ClaimEvent"
    SET "createdAt" = ${input.createdAt}
    WHERE "id" = ${event.id}
  `;

  return event.id;
}

async function createDetachedClaim(organizationId: string): Promise<string> {
  const claim = await prisma.claim.create({
    data: {
      organizationId,
      externalClaimId: `detached-claim-${randomUUID()}`,
      sourceEmail: `detached-${randomUUID()}@example.com`,
      issueSummary: "Detached dashboard event claim",
      status: "PROCESSING",
    },
    select: {
      id: true,
    },
  });

  return claim.id;
}
