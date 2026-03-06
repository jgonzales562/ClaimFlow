import type { WarrantyStatus } from "@prisma/client";
import {
  transitionDashboardClaimStatus,
  updateClaimReview,
} from "./review";

const WARRANTY_STATUSES = ["LIKELY_IN_WARRANTY", "LIKELY_EXPIRED", "UNCLEAR"] as const;
type DashboardTransitionTarget = "REVIEW_REQUIRED" | "READY";
type MembershipRole = "OWNER" | "ADMIN" | "ANALYST" | "VIEWER";
type DashboardClaimActionAuthContext = {
  userId: string;
  organizationId: string;
  role: MembershipRole;
};

type DashboardClaimActionDependencies = {
  getAuthContextFn: () => Promise<DashboardClaimActionAuthContext | null>;
  hasMinimumRoleFn: (currentRole: MembershipRole, requiredRole: MembershipRole) => boolean;
  redirectFn: (location: string) => never;
  revalidatePathFn: (path: string) => void;
  updateClaimReviewFn?: typeof updateClaimReview;
  transitionDashboardClaimStatusFn?: typeof transitionDashboardClaimStatus;
};

export function createDashboardClaimActionHandlers(
  dependencies: DashboardClaimActionDependencies,
): {
  updateClaimReviewAction: (formData: FormData) => Promise<void>;
  transitionClaimStatusAction: (formData: FormData) => Promise<void>;
} {
  const updateClaimReviewFn = dependencies.updateClaimReviewFn ?? updateClaimReview;
  const transitionDashboardClaimStatusFn =
    dependencies.transitionDashboardClaimStatusFn ?? transitionDashboardClaimStatus;

  async function requireAnalystAuth(claimId: string): Promise<DashboardClaimActionAuthContext> {
    const redirectTo = `/dashboard/claims/${claimId}`;
    const auth = await dependencies.getAuthContextFn();
    if (!auth) {
      dependencies.redirectFn(`/login?redirect=${encodeURIComponent(redirectTo)}`);
    }

    if (!dependencies.hasMinimumRoleFn(auth.role, "ANALYST")) {
      dependencies.redirectFn(`${redirectTo}?error=forbidden`);
    }

    return auth;
  }

  async function updateClaimReviewAction(formData: FormData): Promise<void> {
    const claimId = readRequiredString(formData.get("claimId"));
    const auth = await requireAnalystAuth(claimId);

    const nextWarrantyStatus = parseWarrantyStatus(formData.get("warrantyStatus"));
    if (!nextWarrantyStatus) {
      dependencies.redirectFn(`/dashboard/claims/${claimId}?error=invalid_warranty_status`);
    }

    const nextPurchaseDate = parseDateInput(formData.get("purchaseDate"));
    if (nextPurchaseDate === "INVALID") {
      dependencies.redirectFn(`/dashboard/claims/${claimId}?error=invalid_purchase_date`);
    }

    const result = await updateClaimReviewFn({
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
      dependencies.redirectFn("/dashboard?error=claim_not_found");
    }

    if (result.kind === "no_changes") {
      dependencies.redirectFn(`/dashboard/claims/${result.claimId}?notice=no_changes`);
    }

    dependencies.revalidatePathFn("/dashboard");
    dependencies.revalidatePathFn(`/dashboard/claims/${result.claimId}`);
    dependencies.redirectFn(`/dashboard/claims/${result.claimId}?notice=claim_updated`);
  }

  async function transitionClaimStatusAction(formData: FormData): Promise<void> {
    const claimId = readRequiredString(formData.get("claimId"));
    const auth = await requireAnalystAuth(claimId);

    const targetStatus = parseStatusTransitionTarget(formData.get("targetStatus"));
    if (!targetStatus) {
      dependencies.redirectFn(`/dashboard/claims/${claimId}?error=invalid_status_target`);
    }

    const result = await transitionDashboardClaimStatusFn({
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      claimId,
      targetStatus,
    });

    if (result.kind === "claim_not_found") {
      dependencies.redirectFn("/dashboard?error=claim_not_found");
    }

    if (result.kind === "status_unchanged") {
      dependencies.redirectFn(`/dashboard/claims/${result.claimId}?notice=status_unchanged`);
    }

    if (result.kind === "invalid_transition") {
      dependencies.redirectFn(`/dashboard/claims/${result.claimId}?error=invalid_status_transition`);
    }

    dependencies.revalidatePathFn("/dashboard");
    dependencies.revalidatePathFn(`/dashboard/claims/${result.claimId}`);
    dependencies.redirectFn(`/dashboard/claims/${result.claimId}?notice=status_updated`);
  }

  return {
    updateClaimReviewAction,
    transitionClaimStatusAction,
  };
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

function parseStatusTransitionTarget(value: FormDataEntryValue | null): DashboardTransitionTarget | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  if (normalized === "REVIEW_REQUIRED" || normalized === "READY") {
    return normalized;
  }

  return null;
}
