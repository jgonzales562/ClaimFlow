"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthContext, hasMinimumRole } from "@/lib/auth/server";
import { createDashboardClaimActionHandlers } from "@/lib/claims/review-actions";

const dashboardClaimActionHandlers = createDashboardClaimActionHandlers({
  getAuthContextFn: getAuthContext,
  hasMinimumRoleFn: hasMinimumRole,
  redirectFn: redirect,
  revalidatePathFn: revalidatePath,
});

export const updateClaimReviewAction = dashboardClaimActionHandlers.updateClaimReviewAction;
export const transitionClaimStatusAction = dashboardClaimActionHandlers.transitionClaimStatusAction;
export const retryClaimAction = dashboardClaimActionHandlers.retryClaimAction;
export const recoverProcessingAction = dashboardClaimActionHandlers.recoverProcessingAction;
