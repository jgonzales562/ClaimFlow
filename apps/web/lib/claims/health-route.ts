import { createHash, timingSafeEqual } from "node:crypto";
import { captureWebException } from "@/lib/observability/sentry";
import { extractErrorMessage, logError } from "@/lib/observability/log";
import {
  getClaimsHealthBearerToken,
  getClaimsHealthMaxDueOutboxCount,
  getClaimsHealthMaxStaleProcessingCount,
  getClaimsHealthStaleMinutes,
  isClaimsProcessingWatchdogEnabled,
  loadClaimsOperationsHealthSnapshot,
} from "./operations-health";

type ClaimsHealthRouteDependencies = {
  loadClaimsOperationsHealthSnapshotFn?: typeof loadClaimsOperationsHealthSnapshot;
  captureWebExceptionFn?: typeof captureWebException;
  logErrorFn?: typeof logError;
  nowFn?: () => Date;
  getBearerTokenFn?: typeof getClaimsHealthBearerToken;
  getMaxDueOutboxCountFn?: typeof getClaimsHealthMaxDueOutboxCount;
  getMaxStaleProcessingCountFn?: typeof getClaimsHealthMaxStaleProcessingCount;
  getStaleMinutesFn?: typeof getClaimsHealthStaleMinutes;
  isProcessingWatchdogEnabledFn?: typeof isClaimsProcessingWatchdogEnabled;
};

export function createClaimsHealthHandler(
  dependencies: ClaimsHealthRouteDependencies = {},
) {
  const loadClaimsOperationsHealthSnapshotFn =
    dependencies.loadClaimsOperationsHealthSnapshotFn ?? loadClaimsOperationsHealthSnapshot;
  const captureWebExceptionFn =
    dependencies.captureWebExceptionFn ?? captureWebException;
  const logErrorFn = dependencies.logErrorFn ?? logError;
  const nowFn = dependencies.nowFn ?? (() => new Date());
  const getBearerTokenFn = dependencies.getBearerTokenFn ?? getClaimsHealthBearerToken;
  const getMaxDueOutboxCountFn =
    dependencies.getMaxDueOutboxCountFn ?? getClaimsHealthMaxDueOutboxCount;
  const getMaxStaleProcessingCountFn =
    dependencies.getMaxStaleProcessingCountFn ?? getClaimsHealthMaxStaleProcessingCount;
  const getStaleMinutesFn = dependencies.getStaleMinutesFn ?? getClaimsHealthStaleMinutes;
  const isProcessingWatchdogEnabledFn =
    dependencies.isProcessingWatchdogEnabledFn ?? isClaimsProcessingWatchdogEnabled;

  return async function GET(request: Request): Promise<Response> {
    const expectedToken = getBearerTokenFn();
    if (!expectedToken) {
      return Response.json(
        { error: "Claims health endpoint is not configured" },
        { status: 503 },
      );
    }

    const headerValue = request.headers.get("authorization");
    const providedToken = parseBearerToken(headerValue);
    if (!providedToken || !secureCompare(providedToken, expectedToken)) {
      return Response.json(
        { error: "Unauthorized" },
        {
          status: 401,
          headers: {
            "WWW-Authenticate": "Bearer",
          },
        },
      );
    }

    try {
      const generatedAt = nowFn();
      const maxDueOutboxCount = getMaxDueOutboxCountFn();
      const maxStaleProcessingCount = getMaxStaleProcessingCountFn();
      const staleAfterMinutes = getStaleMinutesFn();
      const processingWatchdogEnabled = isProcessingWatchdogEnabledFn();
      const summary = await loadClaimsOperationsHealthSnapshotFn({
        now: generatedAt,
      });

      const staleProcessingStatus =
        summary.staleProcessingCount > maxStaleProcessingCount ? "degraded" : "ok";
      const ingestQueueOutboxStatus =
        summary.ingestQueueOutbox.dueCount > maxDueOutboxCount ? "degraded" : "ok";
      const overallStatus =
        staleProcessingStatus === "degraded" || ingestQueueOutboxStatus === "degraded"
          ? "degraded"
          : "ok";

      return Response.json(
        {
          generatedAt: generatedAt.toISOString(),
          status: overallStatus,
          summary: {
            totalClaims: summary.totalClaims,
            statusCounts: summary.statusCounts,
            staleProcessingCount: summary.staleProcessingCount,
            staleProcessingOrganizationCount: summary.staleProcessingOrganizationCount,
            operationalActivity: summary.operationalActivity,
            ingestQueueOutbox: summary.ingestQueueOutbox,
          },
          checks: {
            staleProcessing: {
              status: staleProcessingStatus,
              observedCount: summary.staleProcessingCount,
              affectedOrganizations: summary.staleProcessingOrganizationCount,
              threshold: maxStaleProcessingCount,
              staleAfterMinutes,
            },
            ingestQueueOutbox: {
              status: ingestQueueOutboxStatus,
              pendingCount: summary.ingestQueueOutbox.pendingCount,
              dueCount: summary.ingestQueueOutbox.dueCount,
              threshold: maxDueOutboxCount,
              oldestPendingAgeMinutes: summary.ingestQueueOutbox.oldestPendingAgeMinutes,
              oldestDueAgeMinutes: summary.ingestQueueOutbox.oldestDueAgeMinutes,
            },
            processingWatchdog: {
              enabled: processingWatchdogEnabled,
            },
          },
        },
        {
          status: overallStatus === "ok" ? 200 : 503,
        },
      );
    } catch (error: unknown) {
      captureWebExceptionFn(error, {
        route: "/api/ops/claims/health",
      });

      logErrorFn("claims_health_snapshot_failed", {
        error: extractErrorMessage(error),
      });

      return Response.json({ error: "Unable to load claims health snapshot" }, { status: 500 });
    }
  };
}

function parseBearerToken(headerValue: string | null): string | null {
  if (!headerValue || !headerValue.startsWith("Bearer ")) {
    return null;
  }

  const token = headerValue.slice("Bearer ".length).trim();
  return token ? token : null;
}

function secureCompare(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}
