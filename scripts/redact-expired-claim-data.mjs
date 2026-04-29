import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const batchSize = parseIntegerEnv("CLAIMFLOW_RETENTION_BATCH_SIZE", 500, 1, 10_000);
const now = new Date();

try {
  const [inboundMessages, claimExtractions, attachments] = await Promise.all([
    prisma.inboundMessage.findMany({
      where: {
        retentionExpiresAt: { lte: now },
        rawPayloadRedactedAt: null,
      },
      orderBy: [{ retentionExpiresAt: "asc" }, { id: "asc" }],
      take: batchSize,
      select: { id: true },
    }),
    prisma.claimExtraction.findMany({
      where: {
        retentionExpiresAt: { lte: now },
        rawOutputRedactedAt: null,
      },
      orderBy: [{ retentionExpiresAt: "asc" }, { id: "asc" }],
      take: batchSize,
      select: { id: true },
    }),
    prisma.claimAttachment.findMany({
      where: {
        retentionExpiresAt: { lte: now },
        deletedAt: null,
      },
      orderBy: [{ retentionExpiresAt: "asc" }, { id: "asc" }],
      take: batchSize,
      select: { id: true },
    }),
  ]);

  const [inboundUpdate, extractionUpdate, attachmentUpdate] = await Promise.all([
    inboundMessages.length === 0
      ? Promise.resolve({ count: 0 })
      : prisma.inboundMessage.updateMany({
          where: {
            id: { in: inboundMessages.map((message) => message.id) },
            rawPayloadRedactedAt: null,
          },
          data: {
            textBody: null,
            htmlBody: null,
            strippedTextReply: null,
            rawPayloadRedactedAt: now,
            rawPayload: {
              redacted: true,
              redactedAt: now.toISOString(),
            },
          },
        }),
    claimExtractions.length === 0
      ? Promise.resolve({ count: 0 })
      : prisma.claimExtraction.updateMany({
          where: {
            id: { in: claimExtractions.map((extraction) => extraction.id) },
            rawOutputRedactedAt: null,
          },
          data: {
            rawOutputRedactedAt: now,
            rawOutput: {
              redacted: true,
              redactedAt: now.toISOString(),
            },
          },
        }),
    attachments.length === 0
      ? Promise.resolve({ count: 0 })
      : prisma.claimAttachment.updateMany({
          where: {
            id: { in: attachments.map((attachment) => attachment.id) },
            deletedAt: null,
          },
          data: {
            deletedAt: now,
          },
        }),
  ]);

  console.log(
    JSON.stringify(
      {
        inboundMessagesSelected: inboundMessages.length,
        inboundMessagesRedacted: inboundUpdate.count,
        claimExtractionsSelected: claimExtractions.length,
        claimExtractionsRedacted: extractionUpdate.count,
        attachmentsSelected: attachments.length,
        attachmentsMarkedDeleted: attachmentUpdate.count,
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}

function parseIntegerEnv(name, fallback, min, max) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }

  return parsed;
}
