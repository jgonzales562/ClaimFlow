import {
  CLAIM_EVENT_PAYLOAD_SCHEMA_VERSION,
  prisma,
  recordClaimStatusTransition,
} from "@claimflow/db";
import type { ClaimStatus, WarrantyStatus } from "@prisma/client";
import { formatDateInput } from "./filters";

type ClaimReviewValues = {
  customerName: string | null;
  productName: string | null;
  serialNumber: string | null;
  purchaseDate: Date | null;
  issueSummary: string | null;
  retailer: string | null;
  warrantyStatus: WarrantyStatus;
  missingInfo: string[];
};

type ClaimReviewChange = {
  field: string;
  before: string | string[] | null;
  after: string | string[] | null;
};

type ClaimReviewUpdateData = {
  customerName?: string | null;
  productName?: string | null;
  serialNumber?: string | null;
  purchaseDate?: Date | null;
  issueSummary?: string | null;
  retailer?: string | null;
  warrantyStatus?: WarrantyStatus;
  missingInfo?: string[];
};

type ClaimReviewDependencies = {
  prismaClient?: typeof prisma;
};

type DashboardTransitionStatus = "REVIEW_REQUIRED" | "READY";

const reviewClaimSelect = {
  id: true,
  customerName: true,
  productName: true,
  serialNumber: true,
  purchaseDate: true,
  issueSummary: true,
  retailer: true,
  warrantyStatus: true,
  missingInfo: true,
} as const;

const transitionClaimSelect = {
  id: true,
  status: true,
} as const;

export async function updateClaimReview(
  input: {
    organizationId: string;
    actorUserId: string;
    claimId: string;
    nextValues: ClaimReviewValues;
  },
  dependencies: ClaimReviewDependencies = {},
): Promise<
  | { kind: "claim_not_found" }
  | { kind: "no_changes"; claimId: string }
  | { kind: "updated"; claimId: string; changedFields: ClaimReviewChange[] }
> {
  const prismaClient = dependencies.prismaClient ?? prisma;

  const claim = await prismaClient.claim.findFirst({
    where: {
      id: input.claimId,
      organizationId: input.organizationId,
    },
    select: reviewClaimSelect,
  });

  if (!claim) {
    return { kind: "claim_not_found" };
  }

  const { changedFields, updateData } = buildClaimReviewMutation(claim, input.nextValues);
  if (changedFields.length === 0) {
    return {
      kind: "no_changes",
      claimId: claim.id,
    };
  }

  await prismaClient.$transaction(async (tx) => {
    await tx.claim.update({
      where: {
        id: claim.id,
      },
      data: updateData,
    });

    await tx.claimEvent.create({
      data: {
        organizationId: input.organizationId,
        claimId: claim.id,
        actorUserId: input.actorUserId,
        eventType: "MANUAL_EDIT",
        payloadSchemaVersion: CLAIM_EVENT_PAYLOAD_SCHEMA_VERSION,
        payload: {
          changedFields,
        },
      },
    });
  });

  return {
    kind: "updated",
    claimId: claim.id,
    changedFields,
  };
}

export async function transitionDashboardClaimStatus(
  input: {
    organizationId: string;
    actorUserId: string;
    claimId: string;
    targetStatus: DashboardTransitionStatus;
  },
  dependencies: ClaimReviewDependencies = {},
): Promise<
  | { kind: "claim_not_found" }
  | { kind: "status_unchanged"; claimId: string }
  | {
      kind: "invalid_transition";
      claimId: string;
      currentStatus: ClaimStatus;
      targetStatus: DashboardTransitionStatus;
    }
  | {
      kind: "updated";
      claimId: string;
      fromStatus: DashboardTransitionStatus;
      toStatus: DashboardTransitionStatus;
    }
> {
  const prismaClient = dependencies.prismaClient ?? prisma;

  const claim = await prismaClient.claim.findFirst({
    where: {
      id: input.claimId,
      organizationId: input.organizationId,
    },
    select: transitionClaimSelect,
  });

  if (!claim) {
    return { kind: "claim_not_found" };
  }

  if (!isDashboardTransitionStatus(claim.status)) {
    return {
      kind: "invalid_transition",
      claimId: claim.id,
      currentStatus: claim.status,
      targetStatus: input.targetStatus,
    };
  }

  if (claim.status === input.targetStatus) {
    return {
      kind: "status_unchanged",
      claimId: claim.id,
    };
  }

  await prismaClient.$transaction(async (tx) => {
    await tx.claim.update({
      where: {
        id: claim.id,
      },
      data: {
        status: input.targetStatus,
      },
    });

    await recordClaimStatusTransition({
      tx,
      organizationId: input.organizationId,
      claimId: claim.id,
      actorUserId: input.actorUserId,
      fromStatus: claim.status,
      toStatus: input.targetStatus,
    });
  });

  return {
    kind: "updated",
    claimId: claim.id,
    fromStatus: claim.status,
    toStatus: input.targetStatus,
  };
}

function isDashboardTransitionStatus(status: ClaimStatus): status is DashboardTransitionStatus {
  return status === "REVIEW_REQUIRED" || status === "READY";
}

function buildClaimReviewMutation(
  claim: {
    customerName: string | null;
    productName: string | null;
    serialNumber: string | null;
    purchaseDate: Date | null;
    issueSummary: string | null;
    retailer: string | null;
    warrantyStatus: WarrantyStatus;
    missingInfo: string[];
  },
  nextValues: ClaimReviewValues,
): {
  changedFields: ClaimReviewChange[];
  updateData: ClaimReviewUpdateData;
} {
  const changedFields: ClaimReviewChange[] = [];
  const updateData: ClaimReviewUpdateData = {};

  if (claim.customerName !== nextValues.customerName) {
    updateData.customerName = nextValues.customerName;
    changedFields.push({
      field: "customerName",
      before: claim.customerName,
      after: nextValues.customerName,
    });
  }

  if (claim.productName !== nextValues.productName) {
    updateData.productName = nextValues.productName;
    changedFields.push({
      field: "productName",
      before: claim.productName,
      after: nextValues.productName,
    });
  }

  if (claim.serialNumber !== nextValues.serialNumber) {
    updateData.serialNumber = nextValues.serialNumber;
    changedFields.push({
      field: "serialNumber",
      before: claim.serialNumber,
      after: nextValues.serialNumber,
    });
  }

  const currentPurchaseDate = formatDateInput(claim.purchaseDate) || null;
  const updatedPurchaseDate = formatDateInput(nextValues.purchaseDate) || null;
  if (currentPurchaseDate !== updatedPurchaseDate) {
    updateData.purchaseDate = nextValues.purchaseDate;
    changedFields.push({
      field: "purchaseDate",
      before: currentPurchaseDate,
      after: updatedPurchaseDate,
    });
  }

  if (claim.issueSummary !== nextValues.issueSummary) {
    updateData.issueSummary = nextValues.issueSummary;
    changedFields.push({
      field: "issueSummary",
      before: claim.issueSummary,
      after: nextValues.issueSummary,
    });
  }

  if (claim.retailer !== nextValues.retailer) {
    updateData.retailer = nextValues.retailer;
    changedFields.push({
      field: "retailer",
      before: claim.retailer,
      after: nextValues.retailer,
    });
  }

  if (claim.warrantyStatus !== nextValues.warrantyStatus) {
    updateData.warrantyStatus = nextValues.warrantyStatus;
    changedFields.push({
      field: "warrantyStatus",
      before: claim.warrantyStatus,
      after: nextValues.warrantyStatus,
    });
  }

  if (!areStringArraysEqual(claim.missingInfo, nextValues.missingInfo)) {
    updateData.missingInfo = nextValues.missingInfo;
    changedFields.push({
      field: "missingInfo",
      before: claim.missingInfo,
      after: nextValues.missingInfo,
    });
  }

  return {
    changedFields,
    updateData,
  };
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}
