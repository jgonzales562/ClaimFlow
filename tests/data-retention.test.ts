import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { prisma, redactExpiredClaimData } from "../packages/db/src/index.ts";

after(async () => {
  await prisma.$disconnect();
});

test("retention job redacts expired raw payloads and marks expired attachments deleted", async () => {
  const suffix = randomUUID();
  const now = new Date("2026-03-05T12:00:00.000Z");
  const expiredAt = new Date("2026-03-01T00:00:00.000Z");
  const futureAt = new Date("2026-04-01T00:00:00.000Z");

  const organization = await prisma.organization.create({
    data: {
      name: `Retention Test ${suffix}`,
      slug: `retention-test-${suffix}`,
    },
    select: {
      id: true,
    },
  });

  try {
    const claim = await prisma.claim.create({
      data: {
        organizationId: organization.id,
        externalClaimId: `retention-${suffix}`,
        sourceEmail: `customer-${suffix}@example.com`,
        issueSummary: "Retention test",
        status: "READY",
      },
      select: {
        id: true,
      },
    });

    const inboundMessage = await prisma.inboundMessage.create({
      data: {
        organizationId: organization.id,
        providerMessageId: `message-${suffix}`,
        fromEmail: `customer-${suffix}@example.com`,
        textBody: "raw text",
        htmlBody: "<p>raw html</p>",
        strippedTextReply: "reply text",
        rawPayload: { body: "raw provider payload" },
        retentionExpiresAt: expiredAt,
        claimId: claim.id,
      },
      select: {
        id: true,
      },
    });

    const retainedInboundMessage = await prisma.inboundMessage.create({
      data: {
        organizationId: organization.id,
        providerMessageId: `message-retained-${suffix}`,
        rawPayload: { body: "keep" },
        retentionExpiresAt: futureAt,
        claimId: claim.id,
      },
      select: {
        id: true,
      },
    });

    const extraction = await prisma.claimExtraction.create({
      data: {
        organizationId: organization.id,
        claimId: claim.id,
        inboundMessageId: inboundMessage.id,
        provider: "OPENAI",
        model: "test-model",
        confidence: 0.9,
        extraction: { confidence: 0.9 },
        rawOutput: { model: "raw output" },
        retentionExpiresAt: expiredAt,
      },
      select: {
        id: true,
      },
    });

    const attachment = await prisma.claimAttachment.create({
      data: {
        organizationId: organization.id,
        claimId: claim.id,
        inboundMessageId: inboundMessage.id,
        originalFilename: "receipt.pdf",
        contentType: "application/pdf",
        byteSize: 5,
        s3Bucket: "retention-bucket",
        s3Key: "retention/key.pdf",
        retentionExpiresAt: expiredAt,
      },
      select: {
        id: true,
      },
    });

    const result = await redactExpiredClaimData({
      prismaClient: prisma,
      now,
      batchSize: 10,
    });

    assert.deepEqual(result, {
      inboundMessagesSelected: 1,
      inboundMessagesRedacted: 1,
      claimExtractionsSelected: 1,
      claimExtractionsRedacted: 1,
      attachmentsSelected: 1,
      attachmentsMarkedDeleted: 1,
    });

    const redactedInbound = await prisma.inboundMessage.findUniqueOrThrow({
      where: { id: inboundMessage.id },
      select: {
        textBody: true,
        htmlBody: true,
        strippedTextReply: true,
        rawPayload: true,
        rawPayloadRedactedAt: true,
      },
    });
    assert.equal(redactedInbound.textBody, null);
    assert.equal(redactedInbound.htmlBody, null);
    assert.equal(redactedInbound.strippedTextReply, null);
    assert.equal((redactedInbound.rawPayload as { redacted?: boolean }).redacted, true);
    assert.equal(redactedInbound.rawPayloadRedactedAt?.toISOString(), now.toISOString());

    const retainedInbound = await prisma.inboundMessage.findUniqueOrThrow({
      where: { id: retainedInboundMessage.id },
      select: { rawPayloadRedactedAt: true, rawPayload: true },
    });
    assert.equal(retainedInbound.rawPayloadRedactedAt, null);
    assert.deepEqual(retainedInbound.rawPayload, { body: "keep" });

    const redactedExtraction = await prisma.claimExtraction.findUniqueOrThrow({
      where: { id: extraction.id },
      select: {
        rawOutput: true,
        rawOutputRedactedAt: true,
      },
    });
    assert.equal((redactedExtraction.rawOutput as { redacted?: boolean }).redacted, true);
    assert.equal(redactedExtraction.rawOutputRedactedAt?.toISOString(), now.toISOString());

    const deletedAttachment = await prisma.claimAttachment.findUniqueOrThrow({
      where: { id: attachment.id },
      select: { deletedAt: true },
    });
    assert.equal(deletedAttachment.deletedAt?.toISOString(), now.toISOString());
  } finally {
    await prisma.organization.delete({
      where: {
        id: organization.id,
      },
    });
  }
});
