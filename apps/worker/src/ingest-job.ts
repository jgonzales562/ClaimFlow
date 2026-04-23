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
  loadStoredAttachmentsFn?: (
    prismaClient: PrismaClient,
    input: {
      claimId: string;
      limit: number;
    },
  ) => Promise<
    Array<{
      id: string;
      originalFilename: string;
      contentType: string | null;
      s3Bucket: string;
      s3Key: string;
    }>
  >;
  persistClaimExtractionOutcomeFn?: (
    prismaClient: PrismaClient,
    input: PersistClaimExtractionOutcomeInput,
  ) => Promise<"READY" | "REVIEW_REQUIRED">;
  logInfoFn?: (event: string, context: Record<string, unknown>) => void;
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
  const loadStoredAttachmentsFn =
    dependencies.loadStoredAttachmentsFn ??
    ((dbClient, input) =>
      dbClient.claimAttachment.findMany({
        where: {
          claimId: input.claimId,
          uploadStatus: "STORED",
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: input.limit,
        select: {
          id: true,
          originalFilename: true,
          contentType: true,
          s3Bucket: true,
          s3Key: true,
        },
      }));
  const persistClaimExtractionOutcomeFn =
    dependencies.persistClaimExtractionOutcomeFn ?? persistClaimExtractionOutcome;
  const logInfoFn = dependencies.logInfoFn ?? (() => {});
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
          processingAttempt: true,
          processingLeaseToken: true,
          processingLeaseClaimedAt: true,
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

  if (claim.processingAttempt > message.processingAttempt) {
    logInfoFn("claim_ingest_attempt_superseded", {
      claimId: claim.id,
      organizationId: claim.organizationId,
      messageVersion: message.version,
      messageProcessingAttempt: message.processingAttempt,
      currentProcessingAttempt: claim.processingAttempt,
    });
    return;
  }

  if (claim.status === "NEW") {
    throw new WorkerMessageError(
      `Claim "${claim.id}" is still NEW for processing attempt ${message.processingAttempt}.`,
      false,
    );
  }

  if (claim.processingAttempt < message.processingAttempt) {
    throw new WorkerMessageError(
      `Claim "${claim.id}" has not advanced to processing attempt ${message.processingAttempt}.`,
      false,
    );
  }

  if (claim.status !== "PROCESSING") {
    return;
  }

  if (claim.processingLeaseToken !== message.processingLeaseToken) {
    logInfoFn("claim_ingest_lease_superseded", {
      claimId: claim.id,
      organizationId: claim.organizationId,
      processingAttempt: message.processingAttempt,
      messageProcessingLeaseToken: message.processingLeaseToken,
      currentProcessingLeaseToken: claim.processingLeaseToken,
    });
    return;
  }

  if (claim.processingLeaseClaimedAt) {
    logInfoFn("claim_ingest_lease_already_claimed", {
      claimId: claim.id,
      organizationId: claim.organizationId,
      processingAttempt: message.processingAttempt,
      processingLeaseToken: message.processingLeaseToken,
      processingLeaseClaimedAt: claim.processingLeaseClaimedAt.toISOString(),
    });
    return;
  }

  const leaseClaimed = await claimProcessingLeaseClaimedByWorker(prismaClient, {
    claimId: claim.id,
    organizationId: claim.organizationId,
    processingAttempt: message.processingAttempt,
    processingLeaseToken: message.processingLeaseToken,
  });

  if (!leaseClaimed) {
    logInfoFn("claim_ingest_lease_claim_conflict", {
      claimId: claim.id,
      organizationId: claim.organizationId,
      processingAttempt: message.processingAttempt,
      processingLeaseToken: message.processingLeaseToken,
    });
    return;
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

  let textractMetadata: Prisma.InputJsonValue = {
    attempted: false,
    reason: "not_triggered",
  };
  let secondaryExtractionResult: ClaimExtractionResult | null = null;

  const shouldCheckTextractAttachments = shouldRunTextractFallback({
    confidence: primaryExtractionResult.extraction.confidence,
    missingInfoCount: primaryExtractionResult.extraction.missingInfo.length,
    inboundTextChars,
    config,
  });
  let shouldAttemptTextract = false;

  if (shouldCheckTextractAttachments) {
    const storedAttachments = await loadStoredAttachmentsFn(prismaClient, {
      claimId: claim.id,
      limit: config.textractMaxAttachments,
    });

    if (storedAttachments.length > 0) {
      shouldAttemptTextract = true;
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
        reason: "no_stored_attachments",
        attachmentsAvailable: 0,
        inboundTextChars,
      } as Prisma.InputJsonValue;
    }
  } else {
    textractMetadata = {
      attempted: false,
      reason: "quality_threshold_not_met",
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
    processingAttempt: message.processingAttempt,
    processingLeaseToken: message.processingLeaseToken,
  });
}

async function claimProcessingLeaseClaimedByWorker(
  prismaClient: PrismaClient,
  input: {
    claimId: string;
    organizationId: string;
    processingAttempt: number;
    processingLeaseToken: string;
  },
): Promise<boolean> {
  const claimed = await prismaClient.claim.updateMany({
    where: {
      id: input.claimId,
      organizationId: input.organizationId,
      status: "PROCESSING",
      processingAttempt: input.processingAttempt,
      processingLeaseToken: input.processingLeaseToken,
      processingLeaseClaimedAt: null,
    },
    data: {
      processingLeaseClaimedAt: new Date(),
    },
  });

  return claimed.count === 1;
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

const EXTRACTION_QUALITY_CONFIDENCE_WEIGHT = 100;
const EXTRACTION_QUALITY_POPULATED_FIELD_WEIGHT = 4;
const EXTRACTION_QUALITY_MISSING_INFO_WEIGHT = 3;

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

  // Prefer higher-confidence extractions first, then fuller payloads, while penalizing gaps.
  return (
    extracted.confidence * EXTRACTION_QUALITY_CONFIDENCE_WEIGHT +
    populatedFields * EXTRACTION_QUALITY_POPULATED_FIELD_WEIGHT -
    extracted.missingInfo.length * EXTRACTION_QUALITY_MISSING_INFO_WEIGHT
  );
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
