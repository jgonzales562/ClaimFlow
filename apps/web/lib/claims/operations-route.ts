import { getAuthContext, hasMinimumRole } from "@/lib/auth/server";
import { captureWebException } from "@/lib/observability/sentry";
import { extractErrorMessage, logError, logInfo } from "@/lib/observability/log";
import { loadDashboardOperationalSummary } from "./dashboard-claims";

type ClaimsOperationsRouteDependencies = {
  getAuthContextFn?: typeof getAuthContext;
  loadDashboardOperationalSummaryFn?: typeof loadDashboardOperationalSummary;
  captureWebExceptionFn?: typeof captureWebException;
  logInfoFn?: typeof logInfo;
  logErrorFn?: typeof logError;
  nowFn?: () => Date;
};

export function createClaimsOperationsHandler(
  dependencies: ClaimsOperationsRouteDependencies = {},
) {
  const getAuthContextFn = dependencies.getAuthContextFn ?? getAuthContext;
  const loadDashboardOperationalSummaryFn =
    dependencies.loadDashboardOperationalSummaryFn ?? loadDashboardOperationalSummary;
  const captureWebExceptionFn =
    dependencies.captureWebExceptionFn ?? captureWebException;
  const logInfoFn = dependencies.logInfoFn ?? logInfo;
  const logErrorFn = dependencies.logErrorFn ?? logError;
  const nowFn = dependencies.nowFn ?? (() => new Date());

  return async function GET(): Promise<Response> {
    const auth = await getAuthContextFn();
    if (!auth) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!hasMinimumRole(auth.role, "ADMIN")) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    try {
      const generatedAt = nowFn();
      const summary = await loadDashboardOperationalSummaryFn({
        organizationId: auth.organizationId,
        now: generatedAt,
      });

      logInfoFn("claims_operations_snapshot_served", {
        organizationId: auth.organizationId,
        userId: auth.userId,
        staleProcessingCount: summary.staleProcessingCount,
        watchdogRecoveryCount: summary.operationalActivity.watchdogRecoveryCount,
        manualProcessingRecoveryCount: summary.operationalActivity.manualProcessingRecoveryCount,
        manualRetryCount: summary.operationalActivity.manualRetryCount,
      });

      return Response.json({
        generatedAt: generatedAt.toISOString(),
        organizationId: auth.organizationId,
        organizationName: auth.organizationName,
        totalClaims: summary.totalClaims,
        statusCounts: summary.statusCounts,
        staleProcessingCount: summary.staleProcessingCount,
        operationalActivity: summary.operationalActivity,
      });
    } catch (error: unknown) {
      captureWebExceptionFn(error, {
        route: "/api/claims/operations",
        organizationId: auth.organizationId,
        userId: auth.userId,
      });

      logErrorFn("claims_operations_snapshot_failed", {
        organizationId: auth.organizationId,
        userId: auth.userId,
        error: extractErrorMessage(error),
      });

      return Response.json({ error: "Unable to load claim operations snapshot" }, { status: 500 });
    }
  };
}
