import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  cleanupDispatchedClaimIngestQueueOutbox,
  dispatchPendingClaimIngestQueueOutbox,
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

test("claim ingest queue outbox summary returns zero counts when no rows exist", async () => {
  const fixture = await createOutboxFixture("summary-empty");
  const now = new Date("2026-03-12T18:00:00.000Z");

  try {
    const summary = await loadClaimIngestQueueOutboxSummary({
      prismaClient: prisma,
      organizationId: fixture.organizationId,
      now,
    });

    assert.deepEqual(summary, {
      pendingCount: 0,
      dueCount: 0,
      oldestPendingAgeMinutes: null,
      oldestPendingCreatedAt: null,
      oldestDueAgeMinutes: null,
      oldestDueAvailableAt: null,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("claim ingest queue outbox summary aggregates pending and due backlog across organizations", async () => {
  const firstFixture = await createOutboxFixture("summary-global-a");
  const secondFixture = await createOutboxFixture("summary-global-b");
  const now = new Date("2026-03-12T18:00:00.000Z");

  try {
    await createOutboxRow({
      organizationId: firstFixture.organizationId,
      claimId: firstFixture.claimId,
      createdAt: new Date("2026-03-12T17:10:00.000Z"),
      availableAt: new Date("2026-03-12T17:20:00.000Z"),
    });
    await createOutboxRow({
      organizationId: secondFixture.organizationId,
      claimId: secondFixture.claimId,
      createdAt: new Date("2026-03-12T16:50:00.000Z"),
      availableAt: new Date("2026-03-12T17:05:00.000Z"),
    });
    await createOutboxRow({
      organizationId: secondFixture.organizationId,
      claimId: secondFixture.claimId,
      createdAt: new Date("2026-03-12T17:55:00.000Z"),
      availableAt: new Date("2026-03-12T18:25:00.000Z"),
    });
    await createOutboxRow({
      organizationId: secondFixture.organizationId,
      claimId: secondFixture.claimId,
      createdAt: new Date("2026-03-12T16:00:00.000Z"),
      availableAt: new Date("2026-03-12T16:10:00.000Z"),
      dispatchedAt: new Date("2026-03-12T16:11:00.000Z"),
    });

    const summary = await loadClaimIngestQueueOutboxSummary({
      prismaClient: prisma,
      now,
    });

    assert.deepEqual(summary, {
      pendingCount: 3,
      dueCount: 2,
      oldestPendingAgeMinutes: 70,
      oldestPendingCreatedAt: new Date("2026-03-12T16:50:00.000Z"),
      oldestDueAgeMinutes: 55,
      oldestDueAvailableAt: new Date("2026-03-12T17:05:00.000Z"),
    });
  } finally {
    await Promise.all([firstFixture.cleanup(), secondFixture.cleanup()]);
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

    assert.deepEqual(
      remainingRows,
      [{ id: pendingId }, { id: recentDispatchedId }].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    );
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

test("claim ingest queue outbox dispatch honors the configured concurrency limit", async () => {
  let activeDispatches = 0;
  let maxActiveDispatches = 0;
  const dispatchedIds: string[] = [];
  const pendingBatches = [[{ id: "outbox-a" }, { id: "outbox-b" }, { id: "outbox-c" }], []];

  const result = await dispatchPendingClaimIngestQueueOutbox(
    {
      prismaClient: {
        claimIngestQueueOutbox: {
          findMany: async () => pendingBatches.shift() ?? [],
        },
      } as unknown as typeof prisma,
      sendMessageFn: async () => ({
        ok: true,
        sqsMessageId: "unused",
      }),
      batchSize: 3,
      concurrency: 2,
      maxBatches: 1,
    },
    {
      dispatchByIdFn: async ({ outboxId }) => {
        activeDispatches += 1;
        maxActiveDispatches = Math.max(maxActiveDispatches, activeDispatches);
        dispatchedIds.push(outboxId);
        await sleep(20);
        activeDispatches -= 1;
        return {
          kind: "dispatched",
          outboxId,
          queueUrl: "https://example.invalid/claims",
          sqsMessageId: `sqs-${outboxId}`,
          persisted: true,
        };
      },
    },
  );

  assert.deepEqual(result, {
    selectedCount: 3,
    dispatchedCount: 3,
    skippedCount: 0,
    failedCount: 0,
  });
  assert.equal(maxActiveDispatches, 2);
  assert.deepEqual(dispatchedIds.sort(), ["outbox-a", "outbox-b", "outbox-c"]);
});

test("claim ingest queue outbox dispatch drains multiple batches up to the configured limit", async () => {
  const findManyCalls: number[] = [];
  const dispatchedIds: string[] = [];
  const pendingBatches = [
    [{ id: "outbox-a" }, { id: "outbox-b" }],
    [{ id: "outbox-c" }, { id: "outbox-d" }],
    [{ id: "outbox-e" }],
  ];

  const result = await dispatchPendingClaimIngestQueueOutbox(
    {
      prismaClient: {
        claimIngestQueueOutbox: {
          findMany: async ({ take }) => {
            findManyCalls.push(take as number);
            return pendingBatches.shift() ?? [];
          },
        },
      } as unknown as typeof prisma,
      sendMessageFn: async () => ({
        ok: true,
        sqsMessageId: "unused",
      }),
      batchSize: 2,
      concurrency: 2,
      maxBatches: 2,
    },
    {
      dispatchByIdFn: async ({ outboxId }) => {
        dispatchedIds.push(outboxId);
        return {
          kind: "dispatched",
          outboxId,
          queueUrl: "https://example.invalid/claims",
          sqsMessageId: `sqs-${outboxId}`,
          persisted: true,
        };
      },
    },
  );

  assert.deepEqual(result, {
    selectedCount: 4,
    dispatchedCount: 4,
    skippedCount: 0,
    failedCount: 0,
  });
  assert.deepEqual(findManyCalls, [2, 2]);
  assert.deepEqual(dispatchedIds.sort(), ["outbox-a", "outbox-b", "outbox-c", "outbox-d"]);
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
