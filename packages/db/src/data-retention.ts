import type { Prisma, PrismaClient } from "@prisma/client";

export type RedactExpiredClaimDataResult = {
  inboundMessagesSelected: number;
  inboundMessagesRedacted: number;
  claimExtractionsSelected: number;
  claimExtractionsRedacted: number;
  attachmentsSelected: number;
  attachmentsMarkedDeleted: number;
};

type ClaimDataRetentionClient = Pick<
  PrismaClient,
  "inboundMessage" | "claimExtraction" | "claimAttachment"
>;

const DEFAULT_RETENTION_BATCH_SIZE = 500;

export async function redactExpiredClaimData(input: {
  prismaClient: ClaimDataRetentionClient;
  now?: Date;
  batchSize?: number;
}): Promise<RedactExpiredClaimDataResult> {
  const now = input.now ?? new Date();
  const batchSize = normalizeBatchSize(input.batchSize);
  const [inboundMessages, claimExtractions, attachments] = await Promise.all([
    input.prismaClient.inboundMessage.findMany({
      where: {
        retentionExpiresAt: {
          lte: now,
        },
        rawPayloadRedactedAt: null,
      },
      orderBy: [{ retentionExpiresAt: "asc" }, { id: "asc" }],
      take: batchSize,
      select: {
        id: true,
      },
    }),
    input.prismaClient.claimExtraction.findMany({
      where: {
        retentionExpiresAt: {
          lte: now,
        },
        rawOutputRedactedAt: null,
      },
      orderBy: [{ retentionExpiresAt: "asc" }, { id: "asc" }],
      take: batchSize,
      select: {
        id: true,
      },
    }),
    input.prismaClient.claimAttachment.findMany({
      where: {
        retentionExpiresAt: {
          lte: now,
        },
        deletedAt: null,
      },
      orderBy: [{ retentionExpiresAt: "asc" }, { id: "asc" }],
      take: batchSize,
      select: {
        id: true,
      },
    }),
  ]);

  const [inboundUpdate, extractionUpdate, attachmentUpdate] = await Promise.all([
    inboundMessages.length === 0
      ? Promise.resolve({ count: 0 })
      : input.prismaClient.inboundMessage.updateMany({
          where: {
            id: {
              in: inboundMessages.map((message) => message.id),
            },
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
            } satisfies Prisma.InputJsonObject,
          },
        }),
    claimExtractions.length === 0
      ? Promise.resolve({ count: 0 })
      : input.prismaClient.claimExtraction.updateMany({
          where: {
            id: {
              in: claimExtractions.map((extraction) => extraction.id),
            },
            rawOutputRedactedAt: null,
          },
          data: {
            rawOutputRedactedAt: now,
            rawOutput: {
              redacted: true,
              redactedAt: now.toISOString(),
            } satisfies Prisma.InputJsonObject,
          },
        }),
    attachments.length === 0
      ? Promise.resolve({ count: 0 })
      : input.prismaClient.claimAttachment.updateMany({
          where: {
            id: {
              in: attachments.map((attachment) => attachment.id),
            },
            deletedAt: null,
          },
          data: {
            deletedAt: now,
          },
        }),
  ]);

  return {
    inboundMessagesSelected: inboundMessages.length,
    inboundMessagesRedacted: inboundUpdate.count,
    claimExtractionsSelected: claimExtractions.length,
    claimExtractionsRedacted: extractionUpdate.count,
    attachmentsSelected: attachments.length,
    attachmentsMarkedDeleted: attachmentUpdate.count,
  };
}

function normalizeBatchSize(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_RETENTION_BATCH_SIZE;
  }

  return Math.max(1, Math.floor(value));
}
