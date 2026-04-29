import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { createAttachmentDownloadHandler } from "../apps/web/lib/claims/attachment-download-route.ts";
import { createClaimsExportHandler } from "../apps/web/lib/claims/export-route.ts";
import { recoverStaleProcessingClaim } from "../apps/web/lib/claims/processing-recovery.ts";
import { retryErroredClaim } from "../apps/web/lib/claims/retry.ts";
import {
  transitionDashboardClaimStatus,
  updateClaimReview,
} from "../apps/web/lib/claims/review.ts";
import { prisma } from "../packages/db/src/index.ts";

after(async () => {
  await prisma.$disconnect();
});

test("claim mutation services do not mutate claims from another organization", async () => {
  const fixture = await createTenantFixture();

  try {
    assert.deepEqual(
      await updateClaimReview({
        organizationId: fixture.orgAId,
        actorUserId: fixture.userAId,
        claimId: fixture.orgBReviewClaimId,
        nextValues: {
          customerName: "Mallory",
          productName: "Other Product",
          serialNumber: "OTHER",
          purchaseDate: null,
          issueSummary: "Cross tenant attempt",
          retailer: "Other Retailer",
          warrantyStatus: "LIKELY_EXPIRED",
          missingInfo: [],
        },
      }),
      { kind: "claim_not_found" },
    );

    assert.deepEqual(
      await transitionDashboardClaimStatus({
        organizationId: fixture.orgAId,
        actorUserId: fixture.userAId,
        claimId: fixture.orgBReviewClaimId,
        targetStatus: "READY",
      }),
      { kind: "claim_not_found" },
    );

    const orgBClaim = await prisma.claim.findUniqueOrThrow({
      where: { id: fixture.orgBReviewClaimId },
      select: {
        customerName: true,
        status: true,
        events: true,
      },
    });
    assert.equal(orgBClaim.customerName, "Original Customer");
    assert.equal(orgBClaim.status, "REVIEW_REQUIRED");
    assert.equal(orgBClaim.events.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("retry and recovery services hide cross-tenant claims", async () => {
  const fixture = await createTenantFixture();

  try {
    assert.deepEqual(
      await retryErroredClaim(
        {
          organizationId: fixture.orgAId,
          actorUserId: fixture.userAId,
          claimId: fixture.orgBErrorClaimId,
        },
        {
          resolveQueueUrlFn: () => "https://example.invalid/claims",
        },
      ),
      { kind: "claim_not_found" },
    );

    assert.deepEqual(
      await recoverStaleProcessingClaim(
        {
          organizationId: fixture.orgAId,
          actorUserId: fixture.userAId,
          claimId: fixture.orgBProcessingClaimId,
        },
        {
          resolveQueueUrlFn: () => "https://example.invalid/claims",
          nowFn: () => new Date("2026-03-05T12:00:00.000Z"),
          staleMinutes: 30,
        },
      ),
      { kind: "claim_not_found" },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("export and attachment routes scope queries to the authenticated organization", async () => {
  const fetchCalls: Array<Record<string, unknown>> = [];
  const exportHandler = createClaimsExportHandler({
    getAuthContextFn: async () => ({
      userId: "user-a",
      organizationId: "org-a",
      organizationName: "Org A",
      email: "user-a@example.com",
      role: "VIEWER",
    }),
    recordAuditEventFn: async () => {},
    fetchClaimExportBatchFn: async (input) => {
      fetchCalls.push(input.where as Record<string, unknown>);
      return [];
    },
  });

  const exportResponse = await exportHandler(
    new Request("http://localhost/api/claims/export?format=json"),
  );
  assert.equal(exportResponse.status, 200);
  assert.equal(fetchCalls[0]?.organizationId, "org-a");

  const attachmentLookups: Array<Record<string, unknown>> = [];
  const attachmentHandler = createAttachmentDownloadHandler({
    getAuthContextFn: async () => ({
      userId: "user-a",
      organizationId: "org-a",
      organizationName: "Org A",
      email: "user-a@example.com",
      role: "VIEWER",
    }),
    findAttachmentFn: async (input) => {
      attachmentLookups.push(input);
      return null;
    },
  });

  const attachmentResponse = await attachmentHandler(
    new Request("http://localhost/api/claims/claim-b/attachments/attachment-b/download"),
    { claimId: "claim-b", attachmentId: "attachment-b" },
  );
  assert.equal(attachmentResponse.status, 404);
  assert.deepEqual(attachmentLookups, [
    {
      organizationId: "org-a",
      claimId: "claim-b",
      attachmentId: "attachment-b",
    },
  ]);
});

async function createTenantFixture(): Promise<{
  orgAId: string;
  orgBId: string;
  userAId: string;
  orgBReviewClaimId: string;
  orgBErrorClaimId: string;
  orgBProcessingClaimId: string;
  cleanup: () => Promise<void>;
}> {
  const suffix = randomUUID();
  const userA = await prisma.user.create({
    data: {
      email: `tenant-user-a-${suffix}@example.com`,
      memberships: {
        create: {
          role: "ANALYST",
          organization: {
            create: {
              name: `Tenant Org A ${suffix}`,
              slug: `tenant-org-a-${suffix}`,
            },
          },
        },
      },
    },
    select: {
      id: true,
      memberships: {
        select: {
          organizationId: true,
        },
      },
    },
  });
  const orgAId = userA.memberships[0]!.organizationId;

  const orgB = await prisma.organization.create({
    data: {
      name: `Tenant Org B ${suffix}`,
      slug: `tenant-org-b-${suffix}`,
    },
    select: {
      id: true,
    },
  });

  const orgBReviewClaim = await prisma.claim.create({
    data: {
      organizationId: orgB.id,
      externalClaimId: `tenant-review-${suffix}`,
      customerName: "Original Customer",
      issueSummary: "Review claim",
      status: "REVIEW_REQUIRED",
    },
    select: { id: true },
  });

  const orgBErrorClaim = await prisma.claim.create({
    data: {
      organizationId: orgB.id,
      externalClaimId: `tenant-error-${suffix}`,
      issueSummary: "Error claim",
      status: "ERROR",
      processingAttempt: 1,
      latestWorkerFailureAt: new Date("2026-03-05T11:00:00.000Z"),
      latestWorkerFailureReason: "retryable failure",
      latestWorkerFailureRetryable: true,
      latestWorkerFailureReceiveCount: 1,
      latestWorkerFailureDisposition: "moved_to_dlq",
      inboundMessages: {
        create: {
          organizationId: orgB.id,
          providerMessageId: `tenant-error-message-${suffix}`,
          rawPayload: { seeded: true },
        },
      },
    },
    select: { id: true },
  });

  const orgBProcessingClaim = await prisma.claim.create({
    data: {
      organizationId: orgB.id,
      externalClaimId: `tenant-processing-${suffix}`,
      issueSummary: "Processing claim",
      status: "PROCESSING",
      processingAttempt: 1,
      inboundMessages: {
        create: {
          organizationId: orgB.id,
          providerMessageId: `tenant-processing-message-${suffix}`,
          rawPayload: { seeded: true },
        },
      },
    },
    select: { id: true },
  });

  await prisma.claim.update({
    where: { id: orgBProcessingClaim.id },
    data: {
      updatedAt: new Date("2026-03-05T10:00:00.000Z"),
    },
  });

  return {
    orgAId,
    orgBId: orgB.id,
    userAId: userA.id,
    orgBReviewClaimId: orgBReviewClaim.id,
    orgBErrorClaimId: orgBErrorClaim.id,
    orgBProcessingClaimId: orgBProcessingClaim.id,
    cleanup: async () => {
      await prisma.organization.deleteMany({
        where: {
          id: {
            in: [orgAId, orgB.id],
          },
        },
      });
      await prisma.user.deleteMany({
        where: {
          id: userA.id,
        },
      });
    },
  };
}
