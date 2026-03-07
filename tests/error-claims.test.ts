import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../packages/db/src/index.ts";
import {
  listErrorClaims,
  parseErrorClaimsCursor,
} from "../apps/web/lib/claims/error-claims.ts";

after(async () => {
  await prisma.$disconnect();
});

test("error claims returns filtered total count instead of the current page length", async () => {
  const { organizationId, cleanup } = await createErrorClaimsFixture();

  try {
    const firstMatchingClaim = await createErrorClaim({
      organizationId,
      externalClaimId: "error-claim-a",
      productName: "Blender Pro",
      updatedAt: new Date("2026-01-03T12:00:00.000Z"),
      failureReason: "first failure",
      processingAttempt: 3,
    });

    await createErrorClaim({
      organizationId,
      externalClaimId: "error-claim-b",
      productName: "Blender Mini",
      updatedAt: new Date("2026-01-02T12:00:00.000Z"),
      failureReason: "second failure",
    });

    await createErrorClaim({
      organizationId,
      externalClaimId: "error-claim-c",
      productName: "Toaster Max",
      updatedAt: new Date("2026-01-01T12:00:00.000Z"),
      failureReason: "non-matching failure",
    });

    const otherOrganization = await createErrorClaimsFixture();
    try {
      await createErrorClaim({
        organizationId: otherOrganization.organizationId,
        externalClaimId: "error-claim-other-org",
        productName: "Blender Hidden",
        updatedAt: new Date("2026-01-04T12:00:00.000Z"),
        failureReason: "other org failure",
      });

      await prisma.claim.create({
        data: {
          organizationId,
          externalClaimId: `ready-claim-${randomUUID()}`,
          sourceEmail: `ready-${randomUUID()}@example.com`,
          productName: "Blender Ready",
          issueSummary: "Should not be counted",
          status: "READY",
        },
      });

      const result = await listErrorClaims({
        organizationId,
        filters: {
          status: null,
          search: "blender",
          createdFrom: null,
          createdTo: null,
        },
        limit: 1,
        cursor: null,
        direction: "next",
      });

      assert.equal(result.claims.length, 1);
      assert.equal(result.totalCount, 2);
      assert.equal(result.claims[0]?.externalClaimId, firstMatchingClaim.externalClaimId);
      assert.equal(result.claims[0]?.processingAttempt, 3);
      assert.deepEqual(result.claims[0]?.failure, {
        source: "worker_failure",
        occurredAt: firstMatchingClaim.failureCreatedAt.toISOString(),
        reason: "first failure",
        retryable: false,
        receiveCount: 3,
        failureDisposition: "moved_to_dlq",
        fromStatus: "PROCESSING",
        toStatus: "ERROR",
      });
      assert.notEqual(result.nextCursor, null);
      assert.equal(result.prevCursor, null);
    } finally {
      await otherOrganization.cleanup();
    }
  } finally {
    await cleanup();
  }
});

test("error claims paginates forward and backward using updated-at cursors", async () => {
  const { organizationId, cleanup } = await createErrorClaimsFixture();

  try {
    const newest = await createErrorClaim({
      organizationId,
      externalClaimId: "page-claim-newest",
      productName: "Newest Product",
      updatedAt: new Date("2026-02-03T12:00:00.000Z"),
      failureReason: "newest failure",
    });

    const middle = await createErrorClaim({
      organizationId,
      externalClaimId: "page-claim-middle",
      productName: "Middle Product",
      updatedAt: new Date("2026-02-02T12:00:00.000Z"),
      failureReason: "middle failure",
    });

    const oldest = await createErrorClaim({
      organizationId,
      externalClaimId: "page-claim-oldest",
      productName: "Oldest Product",
      updatedAt: new Date("2026-02-01T12:00:00.000Z"),
      failureReason: "oldest failure",
    });

    const firstPage = await listErrorClaims({
      organizationId,
      filters: {
        status: null,
        search: null,
        createdFrom: null,
        createdTo: null,
      },
      limit: 2,
      cursor: null,
      direction: "next",
    });

    assert.equal(firstPage.totalCount, 3);
    assert.deepEqual(
      firstPage.claims.map((claim) => claim.externalClaimId),
      [newest.externalClaimId, middle.externalClaimId],
    );
    assert.notEqual(firstPage.nextCursor, null);
    assert.equal(firstPage.prevCursor, null);
    if (!firstPage.nextCursor) {
      throw new Error("Expected a next cursor for the first page.");
    }

    const secondPage = await listErrorClaims({
      organizationId,
      filters: {
        status: null,
        search: null,
        createdFrom: null,
        createdTo: null,
      },
      limit: 2,
      cursor: parseErrorClaimsCursor(firstPage.nextCursor),
      direction: "next",
    });

    assert.equal(secondPage.totalCount, 3);
    assert.deepEqual(
      secondPage.claims.map((claim) => claim.externalClaimId),
      [oldest.externalClaimId],
    );
    assert.equal(secondPage.nextCursor, null);
    assert.notEqual(secondPage.prevCursor, null);
    if (!secondPage.prevCursor) {
      throw new Error("Expected a previous cursor for the second page.");
    }

    const previousPage = await listErrorClaims({
      organizationId,
      filters: {
        status: null,
        search: null,
        createdFrom: null,
        createdTo: null,
      },
      limit: 2,
      cursor: parseErrorClaimsCursor(secondPage.prevCursor),
      direction: "prev",
    });

    assert.equal(previousPage.totalCount, 3);
    assert.deepEqual(
      previousPage.claims.map((claim) => claim.externalClaimId),
      [newest.externalClaimId, middle.externalClaimId],
    );
  } finally {
    await cleanup();
  }
});

async function createErrorClaimsFixture() {
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: {
      name: `Error Claims Test ${suffix}`,
      slug: `error-claims-test-${suffix}`,
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

async function createErrorClaim(input: {
  organizationId: string;
  externalClaimId: string;
  productName: string;
  updatedAt: Date;
  failureReason: string;
  processingAttempt?: number;
}) {
  const claim = await prisma.claim.create({
    data: {
      organizationId: input.organizationId,
      externalClaimId: input.externalClaimId,
      sourceEmail: `${input.externalClaimId}@example.com`,
      customerName: `Customer ${input.externalClaimId}`,
      productName: input.productName,
      issueSummary: `Issue for ${input.externalClaimId}`,
      status: "ERROR",
      processingAttempt: input.processingAttempt ?? 0,
    },
    select: {
      id: true,
      externalClaimId: true,
    },
  });

  const failureEvent = await prisma.claimEvent.create({
    data: {
      organizationId: input.organizationId,
      claimId: claim.id,
      eventType: "STATUS_TRANSITION",
      payload: {
        source: "worker_failure",
        fromStatus: "PROCESSING",
        toStatus: "ERROR",
        reason: input.failureReason,
        retryable: false,
        receiveCount: 3,
        failureDisposition: "moved_to_dlq",
      },
    },
    select: {
      createdAt: true,
    },
  });

  await prisma.$executeRaw`
    UPDATE "Claim"
    SET "updatedAt" = ${input.updatedAt}
    WHERE "id" = ${claim.id}
  `;

  return {
    id: claim.id,
    externalClaimId: claim.externalClaimId,
    failureCreatedAt: failureEvent.createdAt,
  };
}
