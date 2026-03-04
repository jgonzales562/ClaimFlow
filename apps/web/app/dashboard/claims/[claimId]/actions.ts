"use server";

import { prisma } from "@claimflow/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthContext, hasMinimumRole } from "@/lib/auth/server";

const WARRANTY_STATUSES = ["LIKELY_IN_WARRANTY", "LIKELY_EXPIRED", "UNCLEAR"] as const;
type WarrantyStatus = (typeof WARRANTY_STATUSES)[number];

export async function updateClaimReviewAction(formData: FormData): Promise<void> {
  const claimId = readRequiredString(formData.get("claimId"));
  const auth = await requireAnalystAuth(`/dashboard/claims/${claimId}`);

  const claim = await prisma.claim.findFirst({
    where: {
      id: claimId,
      organizationId: auth.organizationId,
    },
    select: {
      id: true,
      customerName: true,
      productName: true,
      serialNumber: true,
      purchaseDate: true,
      issueSummary: true,
      retailer: true,
      warrantyStatus: true,
      missingInfo: true,
    },
  });

  if (!claim) {
    redirect(`/dashboard?error=claim_not_found`);
  }

  const nextWarrantyStatus = parseWarrantyStatus(formData.get("warrantyStatus"));
  if (!nextWarrantyStatus) {
    redirect(`/dashboard/claims/${claim.id}?error=invalid_warranty_status`);
  }

  const nextPurchaseDate = parseDateInput(formData.get("purchaseDate"));
  if (nextPurchaseDate === "INVALID") {
    redirect(`/dashboard/claims/${claim.id}?error=invalid_purchase_date`);
  }

  const nextValues = {
    customerName: normalizeOptionalText(formData.get("customerName"), 200),
    productName: normalizeOptionalText(formData.get("productName"), 200),
    serialNumber: normalizeOptionalText(formData.get("serialNumber"), 200),
    purchaseDate: nextPurchaseDate,
    issueSummary: normalizeOptionalText(formData.get("issueSummary"), 4000),
    retailer: normalizeOptionalText(formData.get("retailer"), 200),
    warrantyStatus: nextWarrantyStatus,
    missingInfo: parseMissingInfo(formData.get("missingInfo")),
  };

  const changedFields: Array<{
    field: string;
    before: string | string[] | null;
    after: string | string[] | null;
  }> = [];
  const updateData: {
    customerName?: string | null;
    productName?: string | null;
    serialNumber?: string | null;
    purchaseDate?: Date | null;
    issueSummary?: string | null;
    retailer?: string | null;
    warrantyStatus?: WarrantyStatus;
    missingInfo?: string[];
  } = {};

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

  const currentPurchaseDate = formatDateIso(claim.purchaseDate);
  const updatedPurchaseDate = formatDateIso(nextValues.purchaseDate);
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

  if (changedFields.length === 0) {
    redirect(`/dashboard/claims/${claim.id}?notice=no_changes`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.claim.update({
      where: { id: claim.id },
      data: updateData,
    });

    await tx.claimEvent.create({
      data: {
        organizationId: auth.organizationId,
        claimId: claim.id,
        actorUserId: auth.userId,
        eventType: "MANUAL_EDIT",
        payload: {
          changedFields,
        },
      },
    });
  });

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/claims/${claim.id}`);
  redirect(`/dashboard/claims/${claim.id}?notice=claim_updated`);
}

export async function transitionClaimStatusAction(formData: FormData): Promise<void> {
  const claimId = readRequiredString(formData.get("claimId"));
  const auth = await requireAnalystAuth(`/dashboard/claims/${claimId}`);

  const targetStatus = parseStatusTransitionTarget(formData.get("targetStatus"));
  if (!targetStatus) {
    redirect(`/dashboard/claims/${claimId}?error=invalid_status_target`);
  }

  const claim = await prisma.claim.findFirst({
    where: {
      id: claimId,
      organizationId: auth.organizationId,
    },
    select: {
      id: true,
      status: true,
    },
  });

  if (!claim) {
    redirect(`/dashboard?error=claim_not_found`);
  }

  if (claim.status === targetStatus) {
    redirect(`/dashboard/claims/${claim.id}?notice=status_unchanged`);
  }

  const canTransition =
    (claim.status === "REVIEW_REQUIRED" && targetStatus === "READY") ||
    (claim.status === "READY" && targetStatus === "REVIEW_REQUIRED");

  if (!canTransition) {
    redirect(`/dashboard/claims/${claim.id}?error=invalid_status_transition`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.claim.update({
      where: { id: claim.id },
      data: { status: targetStatus },
    });

    await tx.claimEvent.create({
      data: {
        organizationId: auth.organizationId,
        claimId: claim.id,
        actorUserId: auth.userId,
        eventType: "STATUS_TRANSITION",
        payload: {
          fromStatus: claim.status,
          toStatus: targetStatus,
        },
      },
    });
  });

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/claims/${claim.id}`);
  redirect(`/dashboard/claims/${claim.id}?notice=status_updated`);
}

async function requireAnalystAuth(redirectTo: string): Promise<{
  userId: string;
  organizationId: string;
  role: string;
}> {
  const auth = await getAuthContext();
  if (!auth) {
    redirect(`/login?redirect=${encodeURIComponent(redirectTo)}`);
  }

  if (!hasMinimumRole(auth.role, "ANALYST")) {
    redirect(`/dashboard/claims/${readClaimIdFromRedirect(redirectTo)}?error=forbidden`);
  }

  return auth;
}

function readRequiredString(value: FormDataEntryValue | null): string {
  if (typeof value !== "string") {
    throw new Error("Missing required form field.");
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Missing required form field.");
  }

  return trimmed;
}

function normalizeOptionalText(value: FormDataEntryValue | null, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.slice(0, maxLength);
}

function parseWarrantyStatus(value: FormDataEntryValue | null): WarrantyStatus | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toUpperCase() as WarrantyStatus;
  return WARRANTY_STATUSES.includes(normalized) ? normalized : null;
}

function parseDateInput(value: FormDataEntryValue | null): Date | null | "INVALID" {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return "INVALID";
  }

  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return "INVALID";
  }

  return parsed;
}

function parseMissingInfo(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string") {
    return [];
  }

  const items = value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => item.slice(0, 100));

  return Array.from(new Set(items)).slice(0, 20);
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function parseStatusTransitionTarget(
  value: FormDataEntryValue | null,
): "REVIEW_REQUIRED" | "READY" | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  if (normalized === "REVIEW_REQUIRED" || normalized === "READY") {
    return normalized;
  }

  return null;
}

function formatDateIso(value: Date | null): string | null {
  if (!value) {
    return null;
  }

  return value.toISOString().slice(0, 10);
}

function readClaimIdFromRedirect(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}
