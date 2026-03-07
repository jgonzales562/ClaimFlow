import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../packages/db/src/index.ts";
import { loadClaimDetail } from "../apps/web/lib/claims/claim-detail.ts";

after(async () => {
  await prisma.$disconnect();
});

test("claim detail is scoped to the organization and returns null for out-of-scope claims", async () => {
  const fixture = await createClaimDetailFixture();
  const otherFixture = await createClaimDetailFixture();

  try {
    const claim = await prisma.claim.create({
      data: {
        organizationId: fixture.organizationId,
        externalClaimId: `claim-detail-${randomUUID()}`,
        sourceEmail: `detail-${randomUUID()}@example.com`,
        issueSummary: "Scoped detail claim",
        status: "READY",
      },
      select: {
        id: true,
      },
    });

    const inScope = await loadClaimDetail({
      organizationId: fixture.organizationId,
      claimId: claim.id,
    });
    const outOfScope = await loadClaimDetail({
      organizationId: otherFixture.organizationId,
      claimId: claim.id,
    });

    assert.notEqual(inScope, null);
    assert.equal(outOfScope, null);
  } finally {
    await fixture.cleanup();
    await otherFixture.cleanup();
  }
});

test("claim detail returns the latest extraction, recent attachments, recent events, and real stored attachment count", async () => {
  const fixture = await createClaimDetailFixture();

  try {
    const claim = await prisma.claim.create({
      data: {
        organizationId: fixture.organizationId,
        externalClaimId: `claim-detail-${randomUUID()}`,
        sourceEmail: `detail-${randomUUID()}@example.com`,
        customerName: "Ada Lovelace",
        productName: "Premium Blender",
        issueSummary: "Motor stopped spinning",
        status: "REVIEW_REQUIRED",
        warrantyStatus: "UNCLEAR",
        missingInfo: ["serial_number"],
      },
      select: {
        id: true,
      },
    });

    for (let index = 0; index < 12; index += 1) {
      const attachment = await prisma.claimAttachment.create({
        data: {
          organizationId: fixture.organizationId,
          claimId: claim.id,
          uploadStatus: index < 7 ? "STORED" : "FAILED",
          originalFilename: `attachment-${index}.pdf`,
          contentType: "application/pdf",
          byteSize: 1024 + index,
          s3Bucket: "test-bucket",
          s3Key: `claim/${claim.id}/attachment-${index}.pdf`,
        },
        select: {
          id: true,
        },
      });

      await prisma.$executeRaw`
        UPDATE "ClaimAttachment"
        SET "createdAt" = ${new Date(Date.UTC(2026, 0, index + 1, 12, 0, 0))}
        WHERE "id" = ${attachment.id}
      `;
    }

    const firstExtraction = await prisma.claimExtraction.create({
      data: {
        organizationId: fixture.organizationId,
        claimId: claim.id,
        provider: "OPENAI",
        model: "gpt-old",
        confidence: 0.61,
        extraction: {
          reasoning: "Older extraction",
        },
        rawOutput: {
          version: 1,
        },
      },
      select: {
        id: true,
      },
    });

    const latestExtraction = await prisma.claimExtraction.create({
      data: {
        organizationId: fixture.organizationId,
        claimId: claim.id,
        provider: "OPENAI",
        model: "gpt-latest",
        confidence: 0.92,
        extraction: {
          reasoning: "Latest extraction",
        },
        rawOutput: {
          version: 2,
        },
      },
      select: {
        id: true,
      },
    });

    await prisma.$executeRaw`
      UPDATE "ClaimExtraction"
      SET "createdAt" = ${new Date("2026-01-02T12:00:00.000Z")}
      WHERE "id" = ${firstExtraction.id}
    `;
    await prisma.$executeRaw`
      UPDATE "ClaimExtraction"
      SET "createdAt" = ${new Date("2026-01-03T12:00:00.000Z")}
      WHERE "id" = ${latestExtraction.id}
    `;

    let newestVisibleEventId: string | null = null;
    let oldestVisibleEventId: string | null = null;

    for (let index = 0; index < 27; index += 1) {
      const event = await prisma.claimEvent.create({
        data: {
          organizationId: fixture.organizationId,
          claimId: claim.id,
          actorUserId: fixture.userId,
          eventType: index % 2 === 0 ? "STATUS_TRANSITION" : "MANUAL_EDIT",
          payload:
            index % 2 === 0
              ? {
                  fromStatus: "PROCESSING",
                  toStatus: "REVIEW_REQUIRED",
                }
              : {
                  changedFields: [{ field: `field_${index}` }],
                },
        },
        select: {
          id: true,
        },
      });

      if (index === 26) {
        newestVisibleEventId = event.id;
      }

      if (index === 2) {
        oldestVisibleEventId = event.id;
      }

      await prisma.$executeRaw`
        UPDATE "ClaimEvent"
        SET "createdAt" = ${new Date(Date.UTC(2026, 1, index + 1, 12, 0, 0))}
        WHERE "id" = ${event.id}
      `;
    }

    const detail = await loadClaimDetail({
      organizationId: fixture.organizationId,
      claimId: claim.id,
    });

    assert.notEqual(detail, null);
    if (!detail) {
      throw new Error("Expected claim detail to load.");
    }

    assert.equal(detail.storedAttachmentCount, 7);
    assert.equal(detail.attachments.length, 10);
    assert.deepEqual(
      detail.attachments.map((attachment) => attachment.originalFilename),
      [
        "attachment-11.pdf",
        "attachment-10.pdf",
        "attachment-9.pdf",
        "attachment-8.pdf",
        "attachment-7.pdf",
        "attachment-6.pdf",
        "attachment-5.pdf",
        "attachment-4.pdf",
        "attachment-3.pdf",
        "attachment-2.pdf",
      ],
    );
    assert.equal(detail.extractions.length, 1);
    assert.equal(detail.extractions[0]?.model, "gpt-latest");
    assert.equal(detail.events.length, 25);
    assert.equal(detail.events[0]?.actorUser?.email, fixture.userEmail);
    assert.equal(detail.events[0]?.actorUser?.fullName, fixture.userFullName);
    assert.equal(detail.events[0]?.id, newestVisibleEventId);
    assert.equal(detail.events[24]?.id, oldestVisibleEventId);
  } finally {
    await fixture.cleanup();
  }
});

test("claim detail flags processing claims that are stale", async () => {
  const fixture = await createClaimDetailFixture();

  try {
    const claim = await prisma.claim.create({
      data: {
        organizationId: fixture.organizationId,
        externalClaimId: `claim-detail-stale-${randomUUID()}`,
        sourceEmail: `detail-stale-${randomUUID()}@example.com`,
        issueSummary: "Stale processing claim",
        status: "PROCESSING",
      },
      select: {
        id: true,
      },
    });

    await prisma.$executeRaw`
      UPDATE "Claim"
      SET "updatedAt" = ${new Date("2026-01-01T12:00:00.000Z")}
      WHERE "id" = ${claim.id}
    `;

    const detail = await loadClaimDetail({
      organizationId: fixture.organizationId,
      claimId: claim.id,
    });

    assert.notEqual(detail, null);
    assert.equal(detail?.status, "PROCESSING");
    assert.equal(detail?.isProcessingStale, true);
  } finally {
    await fixture.cleanup();
  }
});

async function createClaimDetailFixture() {
  const suffix = randomUUID();
  const userEmail = `claim-detail-${suffix}@example.com`;
  const userFullName = `Claim Detail ${suffix}`;
  const user = await prisma.user.create({
    data: {
      email: userEmail,
      fullName: userFullName,
    },
    select: {
      id: true,
    },
  });

  const organization = await prisma.organization.create({
    data: {
      name: `Claim Detail Test ${suffix}`,
      slug: `claim-detail-test-${suffix}`,
    },
    select: {
      id: true,
    },
  });

  return {
    organizationId: organization.id,
    userId: user.id,
    userEmail,
    userFullName,
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
