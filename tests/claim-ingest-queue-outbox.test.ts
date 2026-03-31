import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  cleanupDispatchedClaimIngestQueueOutbox,
  loadClaimIngestQueueOutboxSummary,
  prisma,
} from "../packages/db/src/index.ts";

after(async () => {
  await prisma.$disconnect();
});

test("claim ingest queue outbox summary reports pending and due backlog for one organization", async () => {
  const fixture = await createOutboxFixture("summary");
  const now = new Date("2026-03-12T18:00:00.000Z");

  try {
    await createOutboxRow({
      organizationId: fixture.organizationId,
      claimId: fixture.claimId,
      createdAt: new Date("2026-03-12T17:00:00.000Z"),
      availableAt: new Date("2026-03-12T17:10:00.000Z"),
    });
    await createOutboxRow({
      organizationId: fixture.organizationId,
      claimId: fixture.claimId,
      createdAt: new Date("2026-03-12T17:45:00.000Z"),
      availableAt: new Date("2026-03-12T18:15:00.000Z"),
    });
    await createOutboxRow({
      organizationId: fixture.organizationId,
      claimId: fixture.claimId,
      createdAt: new Date("2026-03-12T16:30:00.000Z"),
      availableAt: new Date("2026-03-12T16:35:00.000Z"),
      dispatchedAt: new Date("2026-03-12T16:36:00.000Z"),
    });

    const summary = await loadClaimIngestQueueOutboxSummary({
      prismaClient: prisma,
      organizationId: fixture.organizationId,
      now,
    });

    assert.deepEqual(summary, {
      pendingCount: 2,
      dueCount: 1,
      oldestPendingAgeMinutes: 60,
      oldestPendingCreatedAt: new Date("2026-03-12T17:00:00.000Z"),
      oldestDueAgeMinutes: 50,
      oldestDueAvailableAt: new Date("2026-03-12T17:10:00.000Z"),
    });
  } finally {
    await fixture.cleanup();
  }
});

test("claim ingest queue outbox cleanup deletes only dispatched rows older than the cutoff", async () => {
  const fixture = await createOutboxFixture("cleanup");

  try {
    const oldDispatchedId = await createOutboxRow({
      organizationId: fixture.organizationId,
      claimId: fixture.claimId,
      createdAt: new Date("2026-03-10T08:00:00.000Z"),
      availableAt: new Date("2026-03-10T08:05:00.000Z"),
      dispatchedAt: new Date("2026-03-10T08:06:00.000Z"),
    });
    const recentDispatchedId = await createOutboxRow({
      organizationId: fixture.organizationId,
      claimId: fixture.claimId,
      createdAt: new Date("2026-03-12T08:00:00.000Z"),
      availableAt: new Date("2026-03-12T08:05:00.000Z"),
      dispatchedAt: new Date("2026-03-12T08:06:00.000Z"),
    });
    const pendingId = await createOutboxRow({
      organizationId: fixture.organizationId,
      claimId: fixture.claimId,
      createdAt: new Date("2026-03-10T09:00:00.000Z"),
      availableAt: new Date("2026-03-10T09:05:00.000Z"),
    });

    const result = await cleanupDispatchedClaimIngestQueueOutbox({
      prismaClient: prisma,
      olderThan: new Date("2026-03-11T00:00:00.000Z"),
      batchSize: 10,
    });

    assert.deepEqual(result, {
      selectedCount: 1,
      deletedCount: 1,
    });

    const remainingRows = await prisma.claimIngestQueueOutbox.findMany({
      where: {
        organizationId: fixture.organizationId,
      },
      orderBy: [{ id: "asc" }],
      select: {
        id: true,
      },
    });

    assert.deepEqual(remainingRows, [
      { id: pendingId },
      { id: recentDispatchedId },
    ].sort((left, right) => left.id.localeCompare(right.id)));
    const deletedRow = await prisma.claimIngestQueueOutbox.findUnique({
      where: {
        id: oldDispatchedId,
      },
      select: {
        id: true,
      },
    });
    assert.equal(deletedRow, null);
  } finally {
    await fixture.cleanup();
  }
});

async function createOutboxFixture(label: string) {
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: {
      name: `Outbox ${label} ${suffix}`,
      slug: `outbox-${label}-${suffix}`,
    },
    select: {
      id: true,
    },
  });

  const claim = await prisma.claim.create({
    data: {
      organizationId: organization.id,
      externalClaimId: `outbox-claim-${suffix}`,
      status: "PROCESSING",
    },
    select: {
      id: true,
    },
  });

  return {
    organizationId: organization.id,
    claimId: claim.id,
    cleanup: async () => {
      await prisma.organization.delete({
        where: {
          id: organization.id,
        },
      });
    },
  };
}

async function createOutboxRow(input: {
  organizationId: string;
  claimId: string;
  createdAt: Date;
  availableAt: Date;
  dispatchedAt?: Date;
}) {
  const id = `outbox-${randomUUID()}`;
  await prisma.claimIngestQueueOutbox.create({
    data: {
      id,
      organizationId: input.organizationId,
      claimId: input.claimId,
      inboundMessageId: `inbound-${id}`,
      providerMessageId: `provider-${id}`,
      queueUrl: "https://example.invalid/claims",
      processingAttempt: 1,
      processingLeaseToken: `lease-${id}`,
      availableAt: input.availableAt,
      createdAt: input.createdAt,
      ...(input.dispatchedAt
        ? {
            dispatchedAt: input.dispatchedAt,
            sqsMessageId: `sqs-${id}`,
          }
        : {}),
    },
  });

  return id;
}
