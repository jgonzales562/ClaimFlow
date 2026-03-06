"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthContext, hasMinimumRole } from "@/lib/auth/server";
import {
  transitionDashboardClaimStatus,
  updateClaimReview,
} from "@/lib/claims/review";

const WARRANTY_STATUSES = ["LIKELY_IN_WARRANTY", "LIKELY_EXPIRED", "UNCLEAR"] as const;
type WarrantyStatus = (typeof WARRANTY_STATUSES)[number];
type AuthContext = NonNullable<Awaited<ReturnType<typeof getAuthContext>>>;

export async function updateClaimReviewAction(formData: FormData): Promise<void> {
  const claimId = readRequiredString(formData.get("claimId"));
  const auth = await requireAnalystAuth(claimId);

  const nextWarrantyStatus = parseWarrantyStatus(formData.get("warrantyStatus"));
  if (!nextWarrantyStatus) {
    redirect(`/dashboard/claims/${claimId}?error=invalid_warranty_status`);
  }

  const nextPurchaseDate = parseDateInput(formData.get("purchaseDate"));
  if (nextPurchaseDate === "INVALID") {
    redirect(`/dashboard/claims/${claimId}?error=invalid_purchase_date`);
  }

  const result = await updateClaimReview({
    organizationId: auth.organizationId,
    actorUserId: auth.userId,
    claimId,
    nextValues: {
    customerName: normalizeOptionalText(formData.get("customerName"), 200),
    productName: normalizeOptionalText(formData.get("productName"), 200),
    serialNumber: normalizeOptionalText(formData.get("serialNumber"), 200),
    purchaseDate: nextPurchaseDate,
    issueSummary: normalizeOptionalText(formData.get("issueSummary"), 4000),
    retailer: normalizeOptionalText(formData.get("retailer"), 200),
    warrantyStatus: nextWarrantyStatus,
    missingInfo: parseMissingInfo(formData.get("missingInfo")),
    },
  });

  if (result.kind === "claim_not_found") {
    redirect("/dashboard?error=claim_not_found");
  }

  if (result.kind === "no_changes") {
    redirect(`/dashboard/claims/${result.claimId}?notice=no_changes`);
  }

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/claims/${result.claimId}`);
  redirect(`/dashboard/claims/${result.claimId}?notice=claim_updated`);
}

export async function transitionClaimStatusAction(formData: FormData): Promise<void> {
  const claimId = readRequiredString(formData.get("claimId"));
  const auth = await requireAnalystAuth(claimId);

  const targetStatus = parseStatusTransitionTarget(formData.get("targetStatus"));
  if (!targetStatus) {
    redirect(`/dashboard/claims/${claimId}?error=invalid_status_target`);
  }

  const result = await transitionDashboardClaimStatus({
    organizationId: auth.organizationId,
    actorUserId: auth.userId,
    claimId,
    targetStatus,
  });

  if (result.kind === "claim_not_found") {
    redirect("/dashboard?error=claim_not_found");
  }

  if (result.kind === "status_unchanged") {
    redirect(`/dashboard/claims/${result.claimId}?notice=status_unchanged`);
  }

  if (result.kind === "invalid_transition") {
    redirect(`/dashboard/claims/${result.claimId}?error=invalid_status_transition`);
  }

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/claims/${result.claimId}`);
  redirect(`/dashboard/claims/${result.claimId}?notice=status_updated`);
}

async function requireAnalystAuth(claimId: string): Promise<AuthContext> {
  const redirectTo = `/dashboard/claims/${claimId}`;
  const auth = await getAuthContext();
  if (!auth) {
    redirect(`/login?redirect=${encodeURIComponent(redirectTo)}`);
  }

  if (!hasMinimumRole(auth.role, "ANALYST")) {
    redirect(`${redirectTo}?error=forbidden`);
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
