import { transitionClaimStatusIfCurrent } from "@claimflow/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  persistClaimExtractionOutcome,
  type PersistClaimExtractionOutcomeInput,
} from "./claim-state.js";
import { extractErrorMessage } from "./errors.js";
import { extractClaimData, type ClaimExtractionResult } from "./extraction.js";
import { WorkerMessageError, type ClaimIngestQueueMessage } from "./queue-handler.js";
import { extractAttachmentTextWithTextract } from "./textract.js";

export type ClaimIngestJobConfig = {
  awsRegion: string;
  openAiApiKey: string | null;
  extractionModel: string;
  extractionReadyConfidence: number;
  extractionMaxInputChars: number;
  textractFallbackEnabled: boolean;
  textractFallbackConfidenceThreshold: number;
  textractFallbackMissingInfoCount: number;
  textractFallbackMinInboundChars: number;
  textractMaxAttachments: number;
  textractMaxTextChars: number;
};

type ClaimIngestJobDependencies = {
  extractClaimDataFn?: typeof extractClaimData;
  extractAttachmentTextWithTextractFn?: typeof extractAttachmentTextWithTextract;
  persistClaimExtractionOutcomeFn?: (
    prismaClient: PrismaClient,
    input: PersistClaimExtractionOutcomeInput,
  ) => Promise<"READY" | "REVIEW_REQUIRED">;
  logErrorFn?: (event: string, context: Record<string, unknown>) => void;
};

export async function processClaimIngestJob(
  prismaClient: PrismaClient,
  config: ClaimIngestJobConfig,
  message: ClaimIngestQueueMessage,
  dependencies: ClaimIngestJobDependencies = {},
): Promise<void> {
  const extractClaimDataFn = dependencies.extractClaimDataFn ?? extractClaimData;
  const extractAttachmentTextWithTextractFn =
    dependencies.extractAttachmentTextWithTextractFn ?? extractAttachmentTextWithTextract;
  const persistClaimExtractionOutcomeFn =
    dependencies.persistClaimExtractionOutcomeFn ?? persistClaimExtractionOutcome;
  const logErrorFn = dependencies.logErrorFn ?? (() => {});

  const inboundMessage = await prismaClient.inboundMessage.findUnique({
    where: { id: message.inboundMessageId },
    select: {
      id: true,
      providerMessageId: true,
      fromEmail: true,
      subject: true,
      textBody: true,
      strippedTextReply: true,
      claim: {
        select: {
          id: true,
          organizationId: true,
          status: true,
          customerName: true,
          productName: true,
          serialNumber: true,
          purchaseDate: true,
          issueSummary: true,
          retailer: true,
        },
      },
    },
  });

  if (!inboundMessage) {
    throw new WorkerMessageError(
      `Inbound message "${message.inboundMessageId}" was not found for claim "${message.claimId}".`,
      false,
    );
  }

  if (!inboundMessage.claim) {
    throw new WorkerMessageError(
      `Claim "${message.claimId}" was not found for ingest processing.`,
      false,
    );
  }

  const claim = inboundMessage.claim;

  if (claim.id !== message.claimId) {
    throw new WorkerMessageError(
      `Inbound message "${inboundMessage.id}" does not belong to claim "${message.claimId}".`,
      false,
    );
  }

  if (claim.organizationId !== message.organizationId) {
    throw new WorkerMessageError(
      `Claim "${message.claimId}" does not belong to organization "${message.organizationId}".`,
      false,
    );
  }

  if (claim.status === "READY" || claim.status === "REVIEW_REQUIRED") {
    return;
  }

  if (claim.status !== "PROCESSING") {
    await prismaClient.$transaction(async (tx) => {
      await transitionClaimStatusIfCurrent({
        tx,
        organizationId: claim.organizationId,
        claimId: claim.id,
        fromStatus: claim.status,
        toStatus: "PROCESSING",
        payload: {
          source: "worker_ingest_start",
          inboundMessageId: message.inboundMessageId,
          providerMessageId: message.providerMessageId,
        },
      });
    });
  }

  const runExtraction = (supplementalText: string | null) =>
    extractClaimDataFn(
      {
        providerMessageId: inboundMessage.providerMessageId,
        fromEmail: inboundMessage.fromEmail,
        subject: inboundMessage.subject,
        textBody: inboundMessage.textBody,
        strippedTextReply: inboundMessage.strippedTextReply,
        claimIssueSummary: claim.issueSummary,
        supplementalText,
      },
      {
        openAiApiKey: config.openAiApiKey,
        model: config.extractionModel,
        maxInputChars: config.extractionMaxInputChars,
      },
    );

  const primaryExtractionResult = await runExtraction(null);

  const inboundTextChars = getInboundTextCharCount(inboundMessage);

  const storedAttachments = await prismaClient.claimAttachment.findMany({
    where: {
      claimId: claim.id,
      uploadStatus: "STORED",
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      originalFilename: true,
      contentType: true,
      s3Bucket: true,
      s3Key: true,
    },
    take: config.textractMaxAttachments,
  });

  let textractMetadata: Prisma.InputJsonValue = {
    attempted: false,
    reason: "not_triggered",
  };
  let secondaryExtractionResult: ClaimExtractionResult | null = null;

  const shouldAttemptTextract =
    storedAttachments.length > 0 &&
    shouldRunTextractFallback({
      confidence: primaryExtractionResult.extraction.confidence,
      missingInfoCount: primaryExtractionResult.extraction.missingInfo.length,
      inboundTextChars,
      config,
    });

  if (shouldAttemptTextract) {
    const textractResult = await extractAttachmentTextWithTextractFn({
      region: config.awsRegion,
      attachments: storedAttachments,
      config: {
        enabled: config.textractFallbackEnabled,
        maxAttachments: config.textractMaxAttachments,
        maxTextChars: config.textractMaxTextChars,
      },
    });

    textractMetadata = textractResult as Prisma.InputJsonValue;

    if (textractResult.text) {
      try {
        secondaryExtractionResult = await runExtraction(textractResult.text);
      } catch (error: unknown) {
        logErrorFn("textract_reextraction_failed", {
          claimId: claim.id,
          inboundMessageId: inboundMessage.id,
          error: extractErrorMessage(error),
        });
      }
    }
  } else {
    textractMetadata = {
      attempted: false,
      reason:
        storedAttachments.length === 0 ? "no_stored_attachments" : "quality_threshold_not_met",
      attachmentsAvailable: storedAttachments.length,
      inboundTextChars,
    } as Prisma.InputJsonValue;
  }

  const selectedExtraction = choosePreferredExtraction(
    primaryExtractionResult,
    secondaryExtractionResult,
  );

  const usedTextractPass =
    secondaryExtractionResult !== null && selectedExtraction === secondaryExtractionResult;

  const extractionSource =
    selectedExtraction.provider === "FALLBACK"
      ? usedTextractPass
        ? "fallback_local_textract"
        : "fallback_local"
      : usedTextractPass
        ? "textract_fallback"
        : "openai_direct";

  await persistClaimExtractionOutcomeFn(prismaClient, {
    claim,
    inboundMessageId: inboundMessage.id,
    selectedExtraction,
    primaryRawOutput: primaryExtractionResult.rawOutput,
    secondaryRawOutput: secondaryExtractionResult?.rawOutput ?? null,
    extractionSource,
    shouldAttemptTextract,
    usedTextractPass,
    textractMetadata,
    inboundTextChars,
    extractionReadyConfidence: config.extractionReadyConfidence,
  });
}

function shouldRunTextractFallback(input: {
  confidence: number;
  missingInfoCount: number;
  inboundTextChars: number;
  config: ClaimIngestJobConfig;
}): boolean {
  if (!input.config.textractFallbackEnabled) {
    return false;
  }

  return (
    input.confidence < input.config.textractFallbackConfidenceThreshold ||
    input.missingInfoCount >= input.config.textractFallbackMissingInfoCount ||
    input.inboundTextChars < input.config.textractFallbackMinInboundChars
  );
}

function choosePreferredExtraction(
  primary: ClaimExtractionResult,
  secondary: ClaimExtractionResult | null,
): ClaimExtractionResult {
  if (!secondary) {
    return primary;
  }

  const primaryScore = extractionQualityScore(primary);
  const secondaryScore = extractionQualityScore(secondary);
  if (secondaryScore > primaryScore) {
    return secondary;
  }

  return primary;
}

function extractionQualityScore(result: ClaimExtractionResult): number {
  const extracted = result.extraction;
  const populatedFields = [
    extracted.customerName,
    extracted.productName,
    extracted.serialNumber,
    extracted.purchaseDate,
    extracted.issueSummary,
    extracted.retailer,
  ].filter((value) => Boolean(value)).length;

  return extracted.confidence * 100 + populatedFields * 4 - extracted.missingInfo.length * 3;
}

function getInboundTextCharCount(input: {
  textBody: string | null;
  strippedTextReply: string | null;
  subject: string | null;
}): number {
  return [input.subject, input.strippedTextReply, input.textBody]
    .filter((value): value is string => Boolean(value))
    .reduce((total, value) => total + value.trim().length, 0);
}
