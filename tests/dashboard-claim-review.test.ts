import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../packages/db/src/index.ts";
import {
  transitionDashboardClaimStatus,
  updateClaimReview,
} from "../apps/web/lib/claims/review.ts";

after(async () => {
  await prisma.$disconnect();
});

test("dashboard claim review persists changed fields and writes a MANUAL_EDIT event", async () => {
  const { organizationId, userId, claimId, cleanup } = await createDashboardClaimFixture({
    status: "REVIEW_REQUIRED",
    customerName: "Original Customer",
    productName: "Original Product",
    serialNumber: "SERIAL-OLD",
    purchaseDate: new Date("2025-12-01T00:00:00.000Z"),
    issueSummary: "Original summary",
    retailer: "Original Retailer",
    warrantyStatus: "UNCLEAR",
    missingInfo: ["retailer"],
  });

  try {
    const result = await updateClaimReview(
      {
        organizationId,
        actorUserId: userId,
        claimId,
        nextValues: {
          customerName: "Updated Customer",
          productName: "Updated Product",
          serialNumber: "SERIAL-NEW",
          purchaseDate: new Date("2026-01-10T00:00:00.000Z"),
          issueSummary: "Updated summary",
          retailer: "Updated Retailer",
          warrantyStatus: "LIKELY_IN_WARRANTY",
          missingInfo: [],
        },
      },
      {
        prismaClient: prisma,
      },
    );

    assert.equal(result.kind, "updated");
    if (result.kind !== "updated") {
      throw new Error("Expected updated claim review result.");
    }

    assert.deepEqual(
      result.changedFields.map((entry) => entry.field),
      [
        "customerName",
        "productName",
        "serialNumber",
        "purchaseDate",
        "issueSummary",
        "retailer",
        "warrantyStatus",
        "missingInfo",
      ],
    );

    const updatedClaim = await prisma.claim.findUniqueOrThrow({
      where: {
        id: claimId,
      },
      select: {
        customerName: true,
        productName: true,
        serialNumber: true,
        purchaseDate: true,
        issueSummary: true,
        retailer: true,
        warrantyStatus: true,
        missingInfo: true,
        events: {
          where: {
            eventType: "MANUAL_EDIT",
          },
          select: {
            actorUserId: true,
            payload: true,
          },
        },
      },
    });

    assert.equal(updatedClaim.customerName, "Updated Customer");
    assert.equal(updatedClaim.productName, "Updated Product");
    assert.equal(updatedClaim.serialNumber, "SERIAL-NEW");
    assert.equal(updatedClaim.purchaseDate?.toISOString(), "2026-01-10T00:00:00.000Z");
    assert.equal(updatedClaim.issueSummary, "Updated summary");
    assert.equal(updatedClaim.retailer, "Updated Retailer");
    assert.equal(updatedClaim.warrantyStatus, "LIKELY_IN_WARRANTY");
    assert.deepEqual(updatedClaim.missingInfo, []);
    assert.equal(updatedClaim.events.length, 1);
    assert.equal(updatedClaim.events[0]?.actorUserId, userId);
    assert.deepEqual(readPayloadRecord(updatedClaim.events[0]?.payload), {
      changedFields: result.changedFields,
    });
  } finally {
    await cleanup();
  }
});

test("dashboard claim review returns no_changes and does not write an event", async () => {
  const existingPurchaseDate = new Date("2025-11-20T00:00:00.000Z");
  const { organizationId, userId, claimId, cleanup } = await createDashboardClaimFixture({
    status: "REVIEW_REQUIRED",
    customerName: "Same Customer",
    productName: "Same Product",
    serialNumber: "SERIAL-SAME",
    purchaseDate: existingPurchaseDate,
    issueSummary: "Same summary",
    retailer: "Same Retailer",
    warrantyStatus: "LIKELY_EXPIRED",
    missingInfo: ["serial_number"],
  });

  try {
    const result = await updateClaimReview(
      {
        organizationId,
        actorUserId: userId,
        claimId,
        nextValues: {
          customerName: "Same Customer",
          productName: "Same Product",
          serialNumber: "SERIAL-SAME",
          purchaseDate: existingPurchaseDate,
          issueSummary: "Same summary",
          retailer: "Same Retailer",
          warrantyStatus: "LIKELY_EXPIRED",
          missingInfo: ["serial_number"],
        },
      },
      {
        prismaClient: prisma,
      },
    );

    assert.deepEqual(result, {
      kind: "no_changes",
      claimId,
    });

    const events = await prisma.claimEvent.findMany({
      where: {
        claimId,
        eventType: "MANUAL_EDIT",
      },
      select: {
        id: true,
      },
    });

    assert.equal(events.length, 0);
  } finally {
    await cleanup();
  }
});

test("dashboard status transition updates REVIEW_REQUIRED claims to READY and writes an event", async () => {
  const { organizationId, userId, claimId, cleanup } = await createDashboardClaimFixture({
    status: "REVIEW_REQUIRED",
  });

  try {
    const result = await transitionDashboardClaimStatus(
      {
        organizationId,
        actorUserId: userId,
        claimId,
        targetStatus: "READY",
      },
      {
        prismaClient: prisma,
      },
    );

    assert.deepEqual(result, {
      kind: "updated",
      claimId,
      fromStatus: "REVIEW_REQUIRED",
      toStatus: "READY",
    });

    const updatedClaim = await prisma.claim.findUniqueOrThrow({
      where: {
        id: claimId,
      },
      select: {
        status: true,
        events: {
          where: {
            eventType: "STATUS_TRANSITION",
          },
          select: {
            actorUserId: true,
            payload: true,
          },
        },
      },
    });

    assert.equal(updatedClaim.status, "READY");
    assert.equal(updatedClaim.events.length, 1);
    assert.equal(updatedClaim.events[0]?.actorUserId, userId);
    assert.deepEqual(readPayloadRecord(updatedClaim.events[0]?.payload), {
      fromStatus: "REVIEW_REQUIRED",
      toStatus: "READY",
    });
  } finally {
    await cleanup();
  }
});

test("dashboard status transition rejects invalid transitions without writing an event", async () => {
  const { organizationId, userId, claimId, cleanup } = await createDashboardClaimFixture({
    status: "NEW",
  });

  try {
    const result = await transitionDashboardClaimStatus(
      {
        organizationId,
        actorUserId: userId,
        claimId,
        targetStatus: "READY",
      },
      {
        prismaClient: prisma,
      },
    );

    assert.deepEqual(result, {
      kind: "invalid_transition",
      claimId,
      currentStatus: "NEW",
      targetStatus: "READY",
    });

    const updatedClaim = await prisma.claim.findUniqueOrThrow({
      where: {
        id: claimId,
      },
      select: {
        status: true,
        events: {
          where: {
            eventType: "STATUS_TRANSITION",
          },
          select: {
            id: true,
          },
        },
      },
    });

    assert.equal(updatedClaim.status, "NEW");
    assert.equal(updatedClaim.events.length, 0);
  } finally {
    await cleanup();
  }
});

function readPayloadRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

async function createDashboardClaimFixture(input: {
  status: "NEW" | "PROCESSING" | "REVIEW_REQUIRED" | "READY" | "ERROR";
  customerName?: string | null;
  productName?: string | null;
  serialNumber?: string | null;
  purchaseDate?: Date | null;
  issueSummary?: string | null;
  retailer?: string | null;
  warrantyStatus?: "LIKELY_IN_WARRANTY" | "LIKELY_EXPIRED" | "UNCLEAR";
  missingInfo?: string[];
}) {
  const suffix = randomUUID();
  const user = await prisma.user.create({
    data: {
      email: `dashboard-claim-${suffix}@example.com`,
    },
    select: {
      id: true,
    },
  });

  const organization = await prisma.organization.create({
    data: {
      name: `Dashboard Claim Test ${suffix}`,
      slug: `dashboard-claim-test-${suffix}`,
    },
    select: {
      id: true,
    },
  });

  const claim = await prisma.claim.create({
    data: {
      organizationId: organization.id,
      externalClaimId: `dashboard-claim-${suffix}`,
      sourceEmail: `claim-${suffix}@example.com`,
      customerName: input.customerName ?? null,
      productName: input.productName ?? null,
      serialNumber: input.serialNumber ?? null,
      purchaseDate: input.purchaseDate ?? null,
      issueSummary: input.issueSummary ?? "Dashboard test issue",
      retailer: input.retailer ?? null,
      warrantyStatus: input.warrantyStatus ?? "UNCLEAR",
      missingInfo: input.missingInfo ?? [],
      status: input.status,
    },
    select: {
      id: true,
    },
  });

  return {
    organizationId: organization.id,
    userId: user.id,
    claimId: claim.id,
    cleanup: async () => {
      await prisma.organization.delete({
        where: {
          id: organization.id,
        },
      });
      await prisma.user.delete({
        where: {
          id: user.id,
        },
      });
    },
  };
}
