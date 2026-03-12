import { prisma } from "@claimflow/db";
import { readWorkerFailureSnapshot, type WorkerFailureEvent } from "./worker-failure";
import { isClaimProcessingStale } from "./processing-health";

const CLAIM_DETAIL_ATTACHMENT_LIMIT = 10;
const CLAIM_DETAIL_EVENT_LIMIT = 25;

export type ClaimDetailRecord = {
  id: string;
  externalClaimId: string | null;
  sourceEmail: string | null;
  customerName: string | null;
  productName: string | null;
  serialNumber: string | null;
  purchaseDate: Date | null;
  issueSummary: string | null;
  retailer: string | null;
  warrantyStatus: "LIKELY_IN_WARRANTY" | "LIKELY_EXPIRED" | "UNCLEAR";
  missingInfo: string[];
  status: "NEW" | "PROCESSING" | "REVIEW_REQUIRED" | "READY" | "ERROR";
  processingAttempt: number;
  processingLeaseToken: string | null;
  processingLeaseClaimedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  isProcessingStale: boolean;
  storedAttachmentCount: number;
  latestFailure: WorkerFailureEvent | null;
  attachments: Array<{
    id: string;
    uploadStatus: "STORED" | "FAILED";
    originalFilename: string;
    contentType: string | null;
    byteSize: number;
    createdAt: Date;
  }>;
  extractions: Array<{
    provider: string;
    model: string;
    confidence: number;
    extraction: unknown;
    createdAt: Date;
  }>;
  events: Array<{
    id: string;
    eventType: string;
    payload: unknown;
    createdAt: Date;
    actorUser: {
      email: string;
      fullName: string | null;
    } | null;
  }>;
};

export async function loadClaimDetail(input: {
  organizationId: string;
  claimId: string;
}): Promise<ClaimDetailRecord | null> {
  const claim = await prisma.claim.findFirst({
    where: {
      id: input.claimId,
      organizationId: input.organizationId,
    },
    select: {
      id: true,
      externalClaimId: true,
      sourceEmail: true,
      customerName: true,
      productName: true,
      serialNumber: true,
      purchaseDate: true,
      issueSummary: true,
      retailer: true,
      warrantyStatus: true,
      missingInfo: true,
      status: true,
      processingAttempt: true,
      processingLeaseToken: true,
      processingLeaseClaimedAt: true,
      latestWorkerFailureAt: true,
      latestWorkerFailureReason: true,
      latestWorkerFailureRetryable: true,
      latestWorkerFailureReceiveCount: true,
      latestWorkerFailureDisposition: true,
      createdAt: true,
      updatedAt: true,
      attachments: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: CLAIM_DETAIL_ATTACHMENT_LIMIT,
        select: {
          id: true,
          uploadStatus: true,
          originalFilename: true,
          contentType: true,
          byteSize: true,
          createdAt: true,
        },
      },
      extractions: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          provider: true,
          model: true,
          confidence: true,
          extraction: true,
          createdAt: true,
        },
      },
      events: {
        where: {
          organizationId: input.organizationId,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: CLAIM_DETAIL_EVENT_LIMIT,
        select: {
          id: true,
          eventType: true,
          payload: true,
          createdAt: true,
          actorUser: {
            select: {
              email: true,
              fullName: true,
            },
          },
        },
      },
      _count: {
        select: {
          attachments: {
            where: {
              organizationId: input.organizationId,
              uploadStatus: "STORED",
            },
          },
        },
      },
    },
  });

  if (!claim) {
    return null;
  }

  const { _count, ...claimRecord } = claim;

  return {
    ...claimRecord,
    isProcessingStale: isClaimProcessingStale(claimRecord.status, claimRecord.updatedAt),
    storedAttachmentCount: _count.attachments,
    latestFailure: readWorkerFailureSnapshot(claimRecord),
  };
}
