import { recordClaimStatusTransition } from "@claimflow/db";
import type { ClaimStatus, Prisma, PrismaClient } from "@prisma/client";
import type { ClaimExtractionResult } from "./extraction.js";

export type PersistClaimExtractionOutcomeInput = {
  claim: {
    id: string;
    organizationId: string;
    processingAttempt: number;
    processingLeaseToken: string | null;
    customerName: string | null;
    productName: string | null;
    serialNumber: string | null;
    purchaseDate: Date | null;
    issueSummary: string | null;
    retailer: string | null;
  };
  inboundMessageId: string;
  selectedExtraction: ClaimExtractionResult;
  primaryRawOutput: Record<string, unknown>;
  secondaryRawOutput: Record<string, unknown> | null;
  extractionSource: "fallback_local_textract" | "fallback_local" | "textract_fallback" | "openai_direct";
  shouldAttemptTextract: boolean;
  usedTextractPass: boolean;
  textractMetadata: Prisma.InputJsonValue;
  inboundTextChars: number;
  extractionReadyConfidence: number;
  processingAttempt?: number;
  processingLeaseToken?: string;
};

export async function markClaimAsError(
  prismaClient: PrismaClient,
  input: {
    claimId: string;
    organizationId: string;
    processingAttempt?: number;
    processingLeaseToken?: string;
    reason: string;
    retryable: boolean;
    receiveCount: number;
    failureDisposition: "moved_to_dlq" | "dropped_non_retryable";
  },
): Promise<void> {
  await prismaClient.$transaction(async (tx) => {
    const transition = await tx.claim.updateMany({
      where: {
        id: input.claimId,
        organizationId: input.organizationId,
        status: "PROCESSING",
        ...(typeof input.processingAttempt === "number"
          ? {
              processingAttempt: input.processingAttempt,
            }
          : {}),
        ...(typeof input.processingLeaseToken === "string"
          ? {
              processingLeaseToken: input.processingLeaseToken,
            }
          : {}),
      },
      data: {
        status: "ERROR",
        processingLeaseToken: null,
        processingLeaseClaimedAt: null,
      },
    });

    if (transition.count !== 1) {
      return;
    }

    await recordClaimStatusTransition({
      tx,
      organizationId: input.organizationId,
      claimId: input.claimId,
      fromStatus: "PROCESSING",
      toStatus: "ERROR",
      payload: {
        source: "worker_failure",
        failureDisposition: input.failureDisposition,
        receiveCount: input.receiveCount,
        retryable: input.retryable,
        reason: input.reason,
      },
    });
  });
}

export async function releaseClaimProcessingLease(
  prismaClient: PrismaClient,
  input: {
    claimId: string;
    organizationId: string;
    processingAttempt?: number;
    processingLeaseToken?: string;
  },
): Promise<void> {
  if (
    typeof input.processingAttempt !== "number" ||
    typeof input.processingLeaseToken !== "string"
  ) {
    return;
  }

  await prismaClient.claim.updateMany({
    where: {
      id: input.claimId,
      organizationId: input.organizationId,
      status: "PROCESSING",
      processingAttempt: input.processingAttempt,
      processingLeaseToken: input.processingLeaseToken,
      NOT: {
        processingLeaseClaimedAt: null,
      },
    },
    data: {
      processingLeaseClaimedAt: null,
    },
  });
}

export async function persistClaimExtractionOutcome(
  prismaClient: PrismaClient,
  input: PersistClaimExtractionOutcomeInput,
): Promise<ClaimStatus> {
  const extracted = input.selectedExtraction.extraction;
  const nextStatus =
    extracted.confidence >= input.extractionReadyConfidence && extracted.missingInfo.length === 0
      ? "READY"
      : "REVIEW_REQUIRED";

  return prismaClient.$transaction(async (tx) => {
    const transition = await tx.claim.updateMany({
      where: {
        id: input.claim.id,
        organizationId: input.claim.organizationId,
        status: "PROCESSING",
        ...(typeof input.processingAttempt === "number"
          ? {
              processingAttempt: input.processingAttempt,
            }
          : {}),
        ...(typeof input.processingLeaseToken === "string"
          ? {
              processingLeaseToken: input.processingLeaseToken,
            }
          : {}),
      },
      data: {
        customerName: extracted.customerName ?? input.claim.customerName,
        productName: extracted.productName ?? input.claim.productName,
        serialNumber: extracted.serialNumber ?? input.claim.serialNumber,
        purchaseDate: parsePurchaseDate(extracted.purchaseDate) ?? input.claim.purchaseDate,
        issueSummary: extracted.issueSummary ?? input.claim.issueSummary,
        retailer: extracted.retailer ?? input.claim.retailer,
        warrantyStatus: extracted.warrantyStatus,
        missingInfo: extracted.missingInfo,
        status: nextStatus,
        processingLeaseToken: null,
        processingLeaseClaimedAt: null,
      },
    });

    if (transition.count !== 1) {
      const currentClaim = await tx.claim.findFirst({
        where: {
          id: input.claim.id,
          organizationId: input.claim.organizationId,
        },
        select: {
          status: true,
        },
      });

      return currentClaim?.status ?? nextStatus;
    }

    const createdExtraction = await tx.claimExtraction.create({
      data: {
        organizationId: input.claim.organizationId,
        claimId: input.claim.id,
        inboundMessageId: input.inboundMessageId,
        provider: input.selectedExtraction.provider,
        model: input.selectedExtraction.model,
        schemaVersion: input.selectedExtraction.schemaVersion,
        confidence: extracted.confidence,
        extraction: extracted as Prisma.InputJsonValue,
        rawOutput: {
          source: input.extractionSource,
          fallbackAttempted: input.shouldAttemptTextract,
          fallbackUsed: input.usedTextractPass,
          inboundTextChars: input.inboundTextChars,
          primary: input.primaryRawOutput,
          textract: input.textractMetadata,
          textractPass: input.secondaryRawOutput,
        } as Prisma.InputJsonValue,
      },
      select: {
        id: true,
      },
    });

    await recordClaimStatusTransition({
      tx,
      organizationId: input.claim.organizationId,
      claimId: input.claim.id,
      fromStatus: "PROCESSING",
      toStatus: nextStatus,
      payload: {
        source: "worker_extraction",
        extractionId: createdExtraction.id,
        confidence: extracted.confidence,
        fallbackUsed: input.usedTextractPass,
      },
    });

    return nextStatus;
  });
}

function parsePurchaseDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}
