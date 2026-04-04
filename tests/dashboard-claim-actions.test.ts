import assert from "node:assert/strict";
import { test } from "node:test";
import { createDashboardClaimActionHandlers } from "../apps/web/lib/claims/review-actions.ts";

class RedirectSignal extends Error {
  readonly location: string;

  constructor(location: string) {
    super(`Redirect: ${location}`);
    this.location = location;
  }
}

test("dashboard review action redirects unauthenticated users to login", async () => {
  const harness = createHarness({
    getAuthContextFn: async () => null,
  });

  await expectRedirect(
    () => harness.handlers.updateClaimReviewAction(buildReviewFormData()),
    "/login?redirect=%2Fdashboard%2Fclaims%2Fclaim-1",
  );
  assert.equal(harness.updateCalls.length, 0);
});

test("dashboard review action redirects forbidden users", async () => {
  const harness = createHarness({
    getAuthContextFn: async () => ({ ...DEFAULT_AUTH, role: "VIEWER" }),
  });

  await expectRedirect(
    () => harness.handlers.updateClaimReviewAction(buildReviewFormData()),
    "/dashboard/claims/claim-1?error=forbidden",
  );
  assert.equal(harness.updateCalls.length, 0);
});

test("dashboard review action rejects invalid warranty status", async () => {
  const harness = createHarness();
  const formData = buildReviewFormData({ warrantyStatus: "invalid" });

  await expectRedirect(
    () => harness.handlers.updateClaimReviewAction(formData),
    "/dashboard/claims/claim-1?error=invalid_warranty_status",
  );
  assert.equal(harness.updateCalls.length, 0);
});

test("dashboard review action rejects invalid purchase dates", async () => {
  const harness = createHarness();
  const formData = buildReviewFormData({ purchaseDate: "03/05/2026" });

  await expectRedirect(
    () => harness.handlers.updateClaimReviewAction(formData),
    "/dashboard/claims/claim-1?error=invalid_purchase_date",
  );
  assert.equal(harness.updateCalls.length, 0);
});

test("dashboard review action redirects to no_changes without revalidation", async () => {
  const harness = createHarness({
    updateClaimReviewFn: async () => ({ kind: "no_changes", claimId: "claim-1" }),
  });

  await expectRedirect(
    () => harness.handlers.updateClaimReviewAction(buildReviewFormData()),
    "/dashboard/claims/claim-1?notice=no_changes",
  );
  assert.deepEqual(harness.revalidatedPaths, []);
  assert.deepEqual(harness.revalidatedSummaryOrganizations, []);
});

test("dashboard review action revalidates and redirects on success", async () => {
  const harness = createHarness({
    updateClaimReviewFn: async (input) => {
      harness.updateCalls.push(input);
      return { kind: "updated", claimId: "claim-1", changedFields: [] };
    },
  });

  await expectRedirect(
    () => harness.handlers.updateClaimReviewAction(buildReviewFormData()),
    "/dashboard/claims/claim-1?notice=claim_updated",
  );

  assert.equal(harness.updateCalls.length, 1);
  assert.equal(harness.updateCalls[0]?.organizationId, DEFAULT_AUTH.organizationId);
  assert.equal(harness.updateCalls[0]?.actorUserId, DEFAULT_AUTH.userId);
  assert.deepEqual(harness.updateCalls[0]?.nextValues, {
    customerName: "Ada Lovelace",
    productName: "Blender 9000",
    serialNumber: "SN-42",
    purchaseDate: new Date("2026-03-05T00:00:00.000Z"),
    issueSummary: "Stopped spinning",
    retailer: "Target",
    warrantyStatus: "LIKELY_IN_WARRANTY",
    missingInfo: ["serial_number", "receipt"],
  });
  assert.deepEqual(harness.revalidatedPaths, ["/dashboard", "/dashboard/claims/claim-1"]);
  assert.deepEqual(harness.revalidatedSummaryOrganizations, [DEFAULT_AUTH.organizationId]);
});

test("dashboard status action rejects invalid targets", async () => {
  const harness = createHarness();
  const formData = buildTransitionFormData({ targetStatus: "bad" });

  await expectRedirect(
    () => harness.handlers.transitionClaimStatusAction(formData),
    "/dashboard/claims/claim-1?error=invalid_status_target",
  );
  assert.equal(harness.transitionCalls.length, 0);
});

test("dashboard status action redirects invalid transitions", async () => {
  const harness = createHarness({
    transitionDashboardClaimStatusFn: async () => ({
      kind: "invalid_transition",
      claimId: "claim-1",
      currentStatus: "NEW",
      targetStatus: "READY",
    }),
  });

  await expectRedirect(
    () => harness.handlers.transitionClaimStatusAction(buildTransitionFormData()),
    "/dashboard/claims/claim-1?error=invalid_status_transition",
  );
  assert.deepEqual(harness.revalidatedPaths, []);
  assert.deepEqual(harness.revalidatedSummaryOrganizations, []);
});

test("dashboard status action redirects unchanged statuses", async () => {
  const harness = createHarness({
    transitionDashboardClaimStatusFn: async () => ({ kind: "status_unchanged", claimId: "claim-1" }),
  });

  await expectRedirect(
    () => harness.handlers.transitionClaimStatusAction(buildTransitionFormData()),
    "/dashboard/claims/claim-1?notice=status_unchanged",
  );
  assert.deepEqual(harness.revalidatedPaths, []);
});

test("dashboard status action revalidates and redirects on success", async () => {
  const harness = createHarness({
    transitionDashboardClaimStatusFn: async (input) => {
      harness.transitionCalls.push(input);
      return {
        kind: "updated",
        claimId: "claim-1",
        fromStatus: "REVIEW_REQUIRED",
        toStatus: "READY",
      };
    },
  });

  await expectRedirect(
    () => harness.handlers.transitionClaimStatusAction(buildTransitionFormData()),
    "/dashboard/claims/claim-1?notice=status_updated",
  );

  assert.equal(harness.transitionCalls.length, 1);
  assert.deepEqual(harness.transitionCalls[0], {
    organizationId: DEFAULT_AUTH.organizationId,
    actorUserId: DEFAULT_AUTH.userId,
    claimId: "claim-1",
    targetStatus: "READY",
  });
  assert.deepEqual(harness.revalidatedPaths, ["/dashboard", "/dashboard/claims/claim-1"]);
  assert.deepEqual(harness.revalidatedSummaryOrganizations, [DEFAULT_AUTH.organizationId]);
});

test("dashboard retry action redirects when the claim is not eligible for retry", async () => {
  const harness = createHarness({
    retryErroredClaimFn: async () => ({ kind: "retry_not_allowed" }),
  });

  await expectRedirect(
    () => harness.handlers.retryClaimAction(buildRetryFormData()),
    "/dashboard/claims/claim-1?error=claim_retry_not_allowed",
  );

  assert.equal(harness.retryCalls.length, 0);
  assert.deepEqual(harness.revalidatedPaths, []);
  assert.deepEqual(harness.revalidatedSummaryOrganizations, []);
});

test("dashboard retry action revalidates and redirects back to the triage page on success", async () => {
  const harness = createHarness({
    retryErroredClaimFn: async (input) => {
      harness.retryCalls.push(input);
      return {
        kind: "retried",
        claimId: "claim-1",
      };
    },
  });

  await expectRedirect(
    () =>
      harness.handlers.retryClaimAction(
        buildRetryFormData({
          returnTo: "/dashboard/errors?search=seed-claim-006&limit=50",
        }),
      ),
    "/dashboard/errors?search=seed-claim-006&limit=50&notice=claim_retry_started",
  );

  assert.equal(harness.retryCalls.length, 1);
  assert.deepEqual(harness.retryCalls[0], {
    organizationId: DEFAULT_AUTH.organizationId,
    actorUserId: DEFAULT_AUTH.userId,
    claimId: "claim-1",
  });
  assert.deepEqual(harness.revalidatedPaths, [
    "/dashboard",
    "/dashboard/errors",
    "/dashboard/claims/claim-1",
  ]);
  assert.deepEqual(harness.revalidatedSummaryOrganizations, [DEFAULT_AUTH.organizationId]);
});

test("dashboard processing recovery action redirects when the claim is not eligible", async () => {
  const harness = createHarness({
    recoverStaleProcessingClaimFn: async () => ({ kind: "recovery_not_allowed" }),
  });

  await expectRedirect(
    () => harness.handlers.recoverProcessingAction(buildProcessingRecoveryFormData()),
    "/dashboard/claims/claim-1?error=claim_processing_recovery_not_allowed",
  );

  assert.equal(harness.recoveryCalls.length, 0);
  assert.deepEqual(harness.revalidatedPaths, []);
  assert.deepEqual(harness.revalidatedSummaryOrganizations, []);
});

test("dashboard processing recovery action revalidates and redirects on success", async () => {
  const harness = createHarness({
    recoverStaleProcessingClaimFn: async (input) => {
      harness.recoveryCalls.push(input);
      return {
        kind: "recovered",
        claimId: "claim-1",
      };
    },
  });

  await expectRedirect(
    () =>
      harness.handlers.recoverProcessingAction(
        buildProcessingRecoveryFormData({
          returnTo: "/dashboard/claims/claim-1?foo=bar",
        }),
      ),
    "/dashboard/claims/claim-1?foo=bar&notice=claim_processing_recovery_started",
  );

  assert.equal(harness.recoveryCalls.length, 1);
  assert.deepEqual(harness.recoveryCalls[0], {
    organizationId: DEFAULT_AUTH.organizationId,
    actorUserId: DEFAULT_AUTH.userId,
    claimId: "claim-1",
  });
  assert.deepEqual(harness.revalidatedPaths, ["/dashboard", "/dashboard/claims/claim-1"]);
  assert.deepEqual(harness.revalidatedSummaryOrganizations, [DEFAULT_AUTH.organizationId]);
});

const DEFAULT_AUTH = {
  userId: "user-1",
  organizationId: "org-1",
  role: "ANALYST" as const,
};

function createHarness(overrides: Partial<Parameters<typeof createDashboardClaimActionHandlers>[0]> = {}) {
  const revalidatedPaths: string[] = [];
  const revalidatedSummaryOrganizations: string[] = [];
  const updateCalls: Array<Record<string, unknown>> = [];
  const transitionCalls: Array<Record<string, unknown>> = [];
  const retryCalls: Array<Record<string, unknown>> = [];
  const recoveryCalls: Array<Record<string, unknown>> = [];

  const handlers = createDashboardClaimActionHandlers({
    getAuthContextFn: overrides.getAuthContextFn ?? (async () => DEFAULT_AUTH),
    hasMinimumRoleFn: overrides.hasMinimumRoleFn ?? ((currentRole, requiredRole) => rankRole(currentRole) >= rankRole(requiredRole)),
    redirectFn: overrides.redirectFn ?? ((location: string): never => {
      throw new RedirectSignal(location);
    }),
    revalidatePathFn: overrides.revalidatePathFn ?? ((path: string) => {
      revalidatedPaths.push(path);
    }),
    revalidateDashboardSummaryCacheFn:
      overrides.revalidateDashboardSummaryCacheFn ??
      ((organizationId: string) => {
        revalidatedSummaryOrganizations.push(organizationId);
      }),
    updateClaimReviewFn: overrides.updateClaimReviewFn ?? (async (input) => {
      updateCalls.push(input as unknown as Record<string, unknown>);
      return { kind: "updated", claimId: input.claimId, changedFields: [] };
    }),
    transitionDashboardClaimStatusFn:
      overrides.transitionDashboardClaimStatusFn ??
      (async (input) => {
        transitionCalls.push(input as unknown as Record<string, unknown>);
        return {
          kind: "updated",
          claimId: input.claimId,
          fromStatus: "REVIEW_REQUIRED",
          toStatus: input.targetStatus,
        };
      }),
    retryErroredClaimFn:
      overrides.retryErroredClaimFn ??
      (async (input) => {
        retryCalls.push(input as unknown as Record<string, unknown>);
        return {
          kind: "retried",
          claimId: input.claimId,
        };
      }),
    recoverStaleProcessingClaimFn:
      overrides.recoverStaleProcessingClaimFn ??
      (async (input) => {
        recoveryCalls.push(input as unknown as Record<string, unknown>);
        return {
          kind: "recovered",
          claimId: input.claimId,
        };
      }),
  });

  return {
    handlers,
    revalidatedPaths,
    revalidatedSummaryOrganizations,
    updateCalls,
    transitionCalls,
    retryCalls,
    recoveryCalls,
  };
}

function buildReviewFormData(
  overrides: Partial<{
    claimId: string;
    customerName: string;
    productName: string;
    serialNumber: string;
    purchaseDate: string;
    issueSummary: string;
    retailer: string;
    warrantyStatus: string;
    missingInfo: string;
  }> = {},
): FormData {
  const formData = new FormData();
  formData.set("claimId", overrides.claimId ?? "claim-1");
  formData.set("customerName", overrides.customerName ?? "Ada Lovelace");
  formData.set("productName", overrides.productName ?? "Blender 9000");
  formData.set("serialNumber", overrides.serialNumber ?? "SN-42");
  formData.set("purchaseDate", overrides.purchaseDate ?? "2026-03-05");
  formData.set("issueSummary", overrides.issueSummary ?? "Stopped spinning");
  formData.set("retailer", overrides.retailer ?? "Target");
  formData.set("warrantyStatus", overrides.warrantyStatus ?? "LIKELY_IN_WARRANTY");
  formData.set("missingInfo", overrides.missingInfo ?? "serial_number\nreceipt\nserial_number");
  return formData;
}

function buildTransitionFormData(
  overrides: Partial<{ claimId: string; targetStatus: string }> = {},
): FormData {
  const formData = new FormData();
  formData.set("claimId", overrides.claimId ?? "claim-1");
  formData.set("targetStatus", overrides.targetStatus ?? "READY");
  return formData;
}

function buildRetryFormData(
  overrides: Partial<{ claimId: string; returnTo: string }> = {},
): FormData {
  const formData = new FormData();
  formData.set("claimId", overrides.claimId ?? "claim-1");
  if (overrides.returnTo) {
    formData.set("returnTo", overrides.returnTo);
  }
  return formData;
}

function buildProcessingRecoveryFormData(
  overrides: Partial<{ claimId: string; returnTo: string }> = {},
): FormData {
  const formData = new FormData();
  formData.set("claimId", overrides.claimId ?? "claim-1");
  if (overrides.returnTo) {
    formData.set("returnTo", overrides.returnTo);
  }
  return formData;
}

async function expectRedirect(
  run: () => Promise<void>,
  expectedLocation: string,
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.equal(error instanceof RedirectSignal, true);
    assert.equal((error as RedirectSignal).location, expectedLocation);
    return true;
  });
}

function rankRole(role: "OWNER" | "ADMIN" | "ANALYST" | "VIEWER"): number {
  if (role === "OWNER") {
    return 4;
  }
  if (role === "ADMIN") {
    return 3;
  }
  if (role === "ANALYST") {
    return 2;
  }
  return 1;
}
