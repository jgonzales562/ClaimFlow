import { recordClaimStatusTransition, transitionClaimStatusIfCurrent } from "@claimflow/db";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { ClaimExtractionResult } from "./extraction.js";

const claimStatusSelect = {
  id: true,
  status: true,
} as const;

export async function markClaimAsError(
  prismaClient: PrismaClient,
  input: {
    claimId: string;
    organizationId: string;
    reason: string;
    retryable: boolean;
    receiveCount: number;
    failureDisposition: "moved_to_dlq" | "dropped_non_retryable";
  },
): Promise<void> {
  await prismaClient.$transaction(async (tx) => {
    const claim = await tx.claim.findFirst({
      where: {
        id: input.claimId,
        organizationId: input.organizationId,
      },
      select: claimStatusSelect,
    });

    if (!claim || claim.status === "ERROR") {
      return;
    }

    await transitionClaimStatusIfCurrent({
      tx,
      organizationId: input.organizationId,
      claimId: claim.id,
      fromStatus: claim.status,
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

export async function persistClaimExtractionOutcome(
  prismaClient: PrismaClient,
  input: {
    claim: {
      id: string;
      organizationId: string;
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
  },
): Promise<"READY" | "REVIEW_REQUIRED"> {
  const extracted = input.selectedExtraction.extraction;
  const nextStatus =
    extracted.confidence >= input.extractionReadyConfidence && extracted.missingInfo.length === 0
      ? "READY"
      : "REVIEW_REQUIRED";

  await prismaClient.$transaction(async (tx) => {
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

    await tx.claim.update({
      where: { id: input.claim.id },
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
  });

  return nextStatus;
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
