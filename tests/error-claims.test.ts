import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../packages/db/src/index.ts";
import {
  parseErrorClaimFailureDispositionFilter,
  parseErrorClaimSort,
  listErrorClaims,
  parseErrorClaimRetryabilityFilter,
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
        sort: "updated_desc",
        retryability: null,
        failureDisposition: null,
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
      sort: "updated_desc",
      retryability: null,
      failureDisposition: null,
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
      sort: "updated_desc",
      retryability: null,
      failureDisposition: null,
      limit: 2,
      cursor: parseErrorClaimsCursor(firstPage.nextCursor, "updated_desc"),
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
      sort: "updated_desc",
      retryability: null,
      failureDisposition: null,
      limit: 2,
      cursor: parseErrorClaimsCursor(secondPage.prevCursor, "updated_desc"),
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

test("error claims treat full email searches as exact source email matches", async () => {
  const { organizationId, cleanup } = await createErrorClaimsFixture();

  try {
    const exactEmailClaim = await createErrorClaim({
      organizationId,
      externalClaimId: "exact-email-claim",
      productName: "Toaster",
      updatedAt: new Date("2026-02-04T12:00:00.000Z"),
      failureReason: "email exact failure",
      sourceEmail: "customer@example.com",
    });

    await createErrorClaim({
      organizationId,
      externalClaimId: "email-mentioned-claim",
      productName: "Microwave",
      updatedAt: new Date("2026-02-03T12:00:00.000Z"),
      failureReason: "mentioned email failure",
      issueSummary: "Follow up with the customer about this warranty issue.",
      sourceEmail: "customer@example.com.au",
    });

    const result = await listErrorClaims({
      organizationId,
      filters: {
        status: null,
        search: "customer@example.com",
        createdFrom: null,
        createdTo: null,
      },
      sort: "updated_desc",
      retryability: null,
      failureDisposition: null,
      limit: 10,
      cursor: null,
      direction: "next",
    });

    assert.equal(result.totalCount, 1);
    assert.deepEqual(
      result.claims.map((claim) => claim.externalClaimId),
      [exactEmailClaim.externalClaimId],
    );
  } finally {
    await cleanup();
  }
});

test("error claims filters by latest worker-failure retryability", async () => {
  const { organizationId, cleanup } = await createErrorClaimsFixture();

  try {
    const retryableClaim = await createErrorClaim({
      organizationId,
      externalClaimId: "retryable-claim",
      productName: "Retryable Product",
      updatedAt: new Date("2026-02-05T12:00:00.000Z"),
      failureReason: "transient failure",
      retryable: true,
    });

    const nonRetryableClaim = await createErrorClaim({
      organizationId,
      externalClaimId: "non-retryable-claim",
      productName: "Non Retryable Product",
      updatedAt: new Date("2026-02-04T12:00:00.000Z"),
      failureReason: "hard failure",
      retryable: false,
    });

    const unknownRetryabilityClaim = await createErrorClaim({
      organizationId,
      externalClaimId: "unknown-claim",
      productName: "Unknown Product",
      updatedAt: new Date("2026-02-03T12:00:00.000Z"),
      failureReason: "unknown failure",
      omitRetryable: true,
    });

    const latestFailureEvent = await prisma.claimEvent.create({
      data: {
        organizationId,
        claimId: retryableClaim.id,
        eventType: "STATUS_TRANSITION",
        payload: {
          source: "worker_failure",
          fromStatus: "PROCESSING",
          toStatus: "ERROR",
          reason: "latest failure is now non-retryable",
          retryable: false,
          receiveCount: 4,
          failureDisposition: "moved_to_dlq",
        },
      },
      select: {
        createdAt: true,
      },
    });

    await setClaimLatestWorkerFailure(retryableClaim.id, {
      occurredAt: latestFailureEvent.createdAt,
      reason: "latest failure is now non-retryable",
      retryable: false,
      receiveCount: 4,
      failureDisposition: "moved_to_dlq",
    });

    const retryableResult = await listErrorClaims({
      organizationId,
      filters: {
        status: null,
        search: null,
        createdFrom: null,
        createdTo: null,
      },
      sort: "updated_desc",
      retryability: "retryable",
      failureDisposition: null,
      limit: 10,
      cursor: null,
      direction: "next",
    });

    assert.equal(retryableResult.totalCount, 0);
    assert.equal(retryableResult.claims.length, 0);

    const nonRetryableResult = await listErrorClaims({
      organizationId,
      filters: {
        status: null,
        search: null,
        createdFrom: null,
        createdTo: null,
      },
      sort: "updated_desc",
      retryability: "non_retryable",
      failureDisposition: null,
      limit: 10,
      cursor: null,
      direction: "next",
    });

    assert.equal(nonRetryableResult.totalCount, 2);
    assert.deepEqual(
      nonRetryableResult.claims.map((claim) => claim.externalClaimId),
      ["retryable-claim", "non-retryable-claim"],
    );
    assert.equal(nonRetryableResult.claims[0]?.failure?.retryable, false);
    assert.equal(nonRetryableResult.claims[1]?.failure?.retryable, false);

    const unknownResult = await listErrorClaims({
      organizationId,
      filters: {
        status: null,
        search: null,
        createdFrom: null,
        createdTo: null,
      },
      sort: "updated_desc",
      retryability: "unknown",
      failureDisposition: null,
      limit: 10,
      cursor: null,
      direction: "next",
    });

    assert.equal(unknownResult.totalCount, 1);
    assert.deepEqual(
      unknownResult.claims.map((claim) => claim.externalClaimId),
      [unknownRetryabilityClaim.externalClaimId],
    );
    assert.equal(unknownResult.claims[0]?.failure?.retryable, null);
  } finally {
    await cleanup();
  }
});

test("error claims sorts by highest receive count with a composite cursor", async () => {
  const { organizationId, cleanup } = await createErrorClaimsFixture();

  try {
    const highest = await createErrorClaim({
      organizationId,
      externalClaimId: "highest-receive-count",
      productName: "Highest Receive Count Product",
      updatedAt: new Date("2026-02-10T12:00:00.000Z"),
      failureReason: "highest count failure",
      receiveCount: 7,
    });

    const middle = await createErrorClaim({
      organizationId,
      externalClaimId: "middle-receive-count",
      productName: "Middle Receive Count Product",
      updatedAt: new Date("2026-02-11T12:00:00.000Z"),
      failureReason: "middle count failure",
      receiveCount: 4,
    });

    const lowest = await createErrorClaim({
      organizationId,
      externalClaimId: "lowest-receive-count",
      productName: "Lowest Receive Count Product",
      updatedAt: new Date("2026-02-12T12:00:00.000Z"),
      failureReason: "lowest count failure",
      receiveCount: 1,
    });

    const firstPage = await listErrorClaims({
      organizationId,
      filters: {
        status: null,
        search: null,
        createdFrom: null,
        createdTo: null,
      },
      sort: "receive_count_desc",
      retryability: null,
      failureDisposition: null,
      limit: 2,
      cursor: null,
      direction: "next",
    });

    assert.equal(firstPage.totalCount, 3);
    assert.deepEqual(
      firstPage.claims.map((claim) => claim.externalClaimId),
      [highest.externalClaimId, middle.externalClaimId],
    );
    assert.notEqual(firstPage.nextCursor, null);
    assert.equal(firstPage.prevCursor, null);
    if (!firstPage.nextCursor) {
      throw new Error("Expected a next cursor for the first receive-count page.");
    }

    const secondPage = await listErrorClaims({
      organizationId,
      filters: {
        status: null,
        search: null,
        createdFrom: null,
        createdTo: null,
      },
      sort: "receive_count_desc",
      retryability: null,
      failureDisposition: null,
      limit: 2,
      cursor: parseErrorClaimsCursor(firstPage.nextCursor, "receive_count_desc"),
      direction: "next",
    });

    assert.equal(secondPage.totalCount, 3);
    assert.deepEqual(
      secondPage.claims.map((claim) => claim.externalClaimId),
      [lowest.externalClaimId],
    );
    assert.equal(secondPage.nextCursor, null);
    assert.notEqual(secondPage.prevCursor, null);
    if (!secondPage.prevCursor) {
      throw new Error("Expected a previous cursor for the second receive-count page.");
    }

    const previousPage = await listErrorClaims({
      organizationId,
      filters: {
        status: null,
        search: null,
        createdFrom: null,
        createdTo: null,
      },
      sort: "receive_count_desc",
      retryability: null,
      failureDisposition: null,
      limit: 2,
      cursor: parseErrorClaimsCursor(secondPage.prevCursor, "receive_count_desc"),
      direction: "prev",
    });

    assert.equal(previousPage.totalCount, 3);
    assert.deepEqual(
      previousPage.claims.map((claim) => claim.externalClaimId),
      [highest.externalClaimId, middle.externalClaimId],
    );
  } finally {
    await cleanup();
  }
});

test("error claims sorts by oldest failure timestamp with a composite cursor", async () => {
  const { organizationId, cleanup } = await createErrorClaimsFixture();

  try {
    const oldestFailure = await createErrorClaim({
      organizationId,
      externalClaimId: "oldest-failure-claim",
      productName: "Oldest Failure Product",
      updatedAt: new Date("2026-02-20T12:00:00.000Z"),
      failureReason: "oldest failure reason",
      failureOccurredAt: new Date("2026-01-10T08:00:00.000Z"),
    });

    const middleFailure = await createErrorClaim({
      organizationId,
      externalClaimId: "middle-failure-claim",
      productName: "Middle Failure Product",
      updatedAt: new Date("2026-02-10T12:00:00.000Z"),
      failureReason: "middle failure reason",
      failureOccurredAt: new Date("2026-01-20T08:00:00.000Z"),
    });

    const newestFailure = await createErrorClaim({
      organizationId,
      externalClaimId: "newest-failure-claim",
      productName: "Newest Failure Product",
      updatedAt: new Date("2026-02-01T12:00:00.000Z"),
      failureReason: "newest failure reason",
      failureOccurredAt: new Date("2026-02-15T08:00:00.000Z"),
    });

    const firstPage = await listErrorClaims({
      organizationId,
      filters: {
        status: null,
        search: null,
        createdFrom: null,
        createdTo: null,
      },
      sort: "failure_oldest_first",
      retryability: null,
      failureDisposition: null,
      limit: 2,
      cursor: null,
      direction: "next",
    });

    assert.equal(firstPage.totalCount, 3);
    assert.deepEqual(
      firstPage.claims.map((claim) => claim.externalClaimId),
      [oldestFailure.externalClaimId, middleFailure.externalClaimId],
    );
    assert.notEqual(firstPage.nextCursor, null);
    assert.equal(firstPage.prevCursor, null);
    if (!firstPage.nextCursor) {
      throw new Error("Expected a next cursor for the first failure-age page.");
    }

    const secondPage = await listErrorClaims({
      organizationId,
      filters: {
        status: null,
        search: null,
        createdFrom: null,
        createdTo: null,
      },
      sort: "failure_oldest_first",
      retryability: null,
      failureDisposition: null,
      limit: 2,
      cursor: parseErrorClaimsCursor(firstPage.nextCursor, "failure_oldest_first"),
      direction: "next",
    });

    assert.equal(secondPage.totalCount, 3);
    assert.deepEqual(
      secondPage.claims.map((claim) => claim.externalClaimId),
      [newestFailure.externalClaimId],
    );
    assert.equal(secondPage.nextCursor, null);
    assert.notEqual(secondPage.prevCursor, null);
    if (!secondPage.prevCursor) {
      throw new Error("Expected a previous cursor for the second failure-age page.");
    }

    const previousPage = await listErrorClaims({
      organizationId,
      filters: {
        status: null,
        search: null,
        createdFrom: null,
        createdTo: null,
      },
      sort: "failure_oldest_first",
      retryability: null,
      failureDisposition: null,
      limit: 2,
      cursor: parseErrorClaimsCursor(secondPage.prevCursor, "failure_oldest_first"),
      direction: "prev",
    });

    assert.equal(previousPage.totalCount, 3);
    assert.deepEqual(
      previousPage.claims.map((claim) => claim.externalClaimId),
      [oldestFailure.externalClaimId, middleFailure.externalClaimId],
    );
  } finally {
    await cleanup();
  }
});

test("parseErrorClaimRetryabilityFilter normalizes supported values", () => {
  assert.equal(parseErrorClaimRetryabilityFilter("retryable"), "retryable");
  assert.equal(parseErrorClaimRetryabilityFilter(" non_retryable "), "non_retryable");
  assert.equal(parseErrorClaimRetryabilityFilter("UNKNOWN"), "unknown");
  assert.equal(parseErrorClaimRetryabilityFilter("invalid"), null);
  assert.equal(parseErrorClaimRetryabilityFilter(null), null);
});

test("parseErrorClaimSort normalizes supported values", () => {
  assert.equal(parseErrorClaimSort("updated_desc"), "updated_desc");
  assert.equal(parseErrorClaimSort(" receive_count_desc "), "receive_count_desc");
  assert.equal(parseErrorClaimSort("failure_oldest_first"), "failure_oldest_first");
  assert.equal(parseErrorClaimSort("invalid"), "updated_desc");
  assert.equal(parseErrorClaimSort(null), "updated_desc");
});

test("error claims filters by latest worker-failure disposition", async () => {
  const { organizationId, cleanup } = await createErrorClaimsFixture();

  try {
    const supersededRetryingClaim = await createErrorClaim({
      organizationId,
      externalClaimId: "superseded-retrying-claim",
      productName: "Superseded Retrying Product",
      updatedAt: new Date("2026-02-08T12:00:00.000Z"),
      failureReason: "first retrying failure",
      failureDisposition: "retrying",
    });

    const activeRetryingClaim = await createErrorClaim({
      organizationId,
      externalClaimId: "active-retrying-claim",
      productName: "Active Retrying Product",
      updatedAt: new Date("2026-02-07T12:00:00.000Z"),
      failureReason: "still retrying",
      failureDisposition: "retrying",
    });

    const droppedClaim = await createErrorClaim({
      organizationId,
      externalClaimId: "dropped-claim",
      productName: "Dropped Product",
      updatedAt: new Date("2026-02-06T12:00:00.000Z"),
      failureReason: "dropped after classification",
      failureDisposition: "dropped_non_retryable",
    });

    const unknownDispositionClaim = await createErrorClaim({
      organizationId,
      externalClaimId: "unknown-disposition-claim",
      productName: "Unknown Disposition Product",
      updatedAt: new Date("2026-02-05T12:00:00.000Z"),
      failureReason: "unknown disposition failure",
      omitFailureDisposition: true,
    });

    const latestFailureEvent = await prisma.claimEvent.create({
      data: {
        organizationId,
        claimId: supersededRetryingClaim.id,
        eventType: "STATUS_TRANSITION",
        payload: {
          source: "worker_failure",
          fromStatus: "PROCESSING",
          toStatus: "ERROR",
          reason: "latest failure moved the claim to the DLQ",
          retryable: false,
          receiveCount: 5,
          failureDisposition: "moved_to_dlq",
        },
      },
      select: {
        createdAt: true,
      },
    });

    await setClaimLatestWorkerFailure(supersededRetryingClaim.id, {
      occurredAt: latestFailureEvent.createdAt,
      reason: "latest failure moved the claim to the DLQ",
      retryable: false,
      receiveCount: 5,
      failureDisposition: "moved_to_dlq",
    });

    const retryingResult = await listErrorClaims({
      organizationId,
      filters: {
        status: null,
        search: null,
        createdFrom: null,
        createdTo: null,
      },
      sort: "updated_desc",
      retryability: null,
      failureDisposition: "retrying",
      limit: 10,
      cursor: null,
      direction: "next",
    });

    assert.equal(retryingResult.totalCount, 1);
    assert.deepEqual(
      retryingResult.claims.map((claim) => claim.externalClaimId),
      [activeRetryingClaim.externalClaimId],
    );
    assert.equal(retryingResult.claims[0]?.failure?.failureDisposition, "retrying");

    const movedToDlqResult = await listErrorClaims({
      organizationId,
      filters: {
        status: null,
        search: null,
        createdFrom: null,
        createdTo: null,
      },
      sort: "updated_desc",
      retryability: null,
      failureDisposition: "moved_to_dlq",
      limit: 10,
      cursor: null,
      direction: "next",
    });

    assert.equal(movedToDlqResult.totalCount, 1);
    assert.deepEqual(
      movedToDlqResult.claims.map((claim) => claim.externalClaimId),
      [supersededRetryingClaim.externalClaimId],
    );
    assert.equal(movedToDlqResult.claims[0]?.failure?.failureDisposition, "moved_to_dlq");

    const droppedResult = await listErrorClaims({
      organizationId,
      filters: {
        status: null,
        search: null,
        createdFrom: null,
        createdTo: null,
      },
      sort: "updated_desc",
      retryability: null,
      failureDisposition: "dropped_non_retryable",
      limit: 10,
      cursor: null,
      direction: "next",
    });

    assert.equal(droppedResult.totalCount, 1);
    assert.deepEqual(
      droppedResult.claims.map((claim) => claim.externalClaimId),
      [droppedClaim.externalClaimId],
    );
    assert.equal(droppedResult.claims[0]?.failure?.failureDisposition, "dropped_non_retryable");

    const unknownResult = await listErrorClaims({
      organizationId,
      filters: {
        status: null,
        search: null,
        createdFrom: null,
        createdTo: null,
      },
      sort: "updated_desc",
      retryability: null,
      failureDisposition: "unknown",
      limit: 10,
      cursor: null,
      direction: "next",
    });

    assert.equal(unknownResult.totalCount, 1);
    assert.deepEqual(
      unknownResult.claims.map((claim) => claim.externalClaimId),
      [unknownDispositionClaim.externalClaimId],
    );
    assert.equal(unknownResult.claims[0]?.failure?.failureDisposition, null);
  } finally {
    await cleanup();
  }
});

test("parseErrorClaimFailureDispositionFilter normalizes supported values", () => {
  assert.equal(parseErrorClaimFailureDispositionFilter("retrying"), "retrying");
  assert.equal(parseErrorClaimFailureDispositionFilter(" moved_to_dlq "), "moved_to_dlq");
  assert.equal(
    parseErrorClaimFailureDispositionFilter("DROPPED_NON_RETRYABLE"),
    "dropped_non_retryable",
  );
  assert.equal(parseErrorClaimFailureDispositionFilter("UNKNOWN"), "unknown");
  assert.equal(parseErrorClaimFailureDispositionFilter("invalid"), null);
  assert.equal(parseErrorClaimFailureDispositionFilter(null), null);
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
  sourceEmail?: string;
  issueSummary?: string;
  failureOccurredAt?: Date;
  processingAttempt?: number;
  retryable?: boolean;
  omitRetryable?: boolean;
  receiveCount?: number;
  failureDisposition?: string;
  omitFailureDisposition?: boolean;
}) {
  const claim = await prisma.claim.create({
    data: {
      organizationId: input.organizationId,
      externalClaimId: input.externalClaimId,
      sourceEmail: input.sourceEmail ?? `${input.externalClaimId}@example.com`,
      customerName: `Customer ${input.externalClaimId}`,
      productName: input.productName,
      issueSummary: input.issueSummary ?? `Issue for ${input.externalClaimId}`,
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
        ...(input.omitRetryable ? {} : { retryable: input.retryable ?? false }),
        receiveCount: input.receiveCount ?? 3,
        ...(input.omitFailureDisposition
          ? {}
          : { failureDisposition: input.failureDisposition ?? "moved_to_dlq" }),
      },
    },
    select: {
      id: true,
      createdAt: true,
    },
  });

  if (input.failureOccurredAt) {
    await prisma.$executeRaw`
      UPDATE "ClaimEvent"
      SET "createdAt" = ${input.failureOccurredAt}
      WHERE "id" = ${failureEvent.id}
    `;
  }

  await prisma.$executeRaw`
    UPDATE "Claim"
    SET "updatedAt" = ${input.updatedAt}
    WHERE "id" = ${claim.id}
  `;

  await setClaimLatestWorkerFailure(claim.id, {
    occurredAt: input.failureOccurredAt ?? failureEvent.createdAt,
    reason: input.failureReason,
    retryable: input.omitRetryable ? null : (input.retryable ?? false),
    receiveCount: input.receiveCount ?? 3,
    failureDisposition: input.omitFailureDisposition
      ? null
      : (input.failureDisposition ?? "moved_to_dlq"),
  });

  return {
    id: claim.id,
    externalClaimId: claim.externalClaimId,
    failureCreatedAt: input.failureOccurredAt ?? failureEvent.createdAt,
  };
}

async function setClaimLatestWorkerFailure(
  claimId: string,
  input: {
    occurredAt: Date;
    reason: string | null;
    retryable: boolean | null;
    receiveCount: number | null;
    failureDisposition: string | null;
  },
) {
  await prisma.$executeRaw`
    UPDATE "Claim"
    SET
      "latestWorkerFailureAt" = ${input.occurredAt.toISOString()}::timestamp,
      "latestWorkerFailureReason" = ${input.reason},
      "latestWorkerFailureRetryable" = ${input.retryable},
      "latestWorkerFailureReceiveCount" = ${input.receiveCount},
      "latestWorkerFailureDisposition" = ${input.failureDisposition}
    WHERE "id" = ${claimId}
  `;
}
