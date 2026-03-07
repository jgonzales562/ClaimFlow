import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaimsOperationsHandler } from "../apps/web/lib/claims/operations-route.ts";

const ADMIN_AUTH = {
  userId: "user-ops-test",
  organizationId: "org-ops-test",
  organizationName: "Ops Test Org",
  role: "ADMIN" as const,
  email: "ops-admin@example.com",
};

test("claims operations rejects unauthenticated requests", async () => {
  const handler = createClaimsOperationsHandler({
    getAuthContextFn: async () => null,
  });

  const response = await handler();

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
});

test("claims operations rejects users below admin role", async () => {
  const handler = createClaimsOperationsHandler({
    getAuthContextFn: async () => ({
      ...ADMIN_AUTH,
      role: "ANALYST" as const,
    }),
  });

  const response = await handler();

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Forbidden" });
});

test("claims operations returns a machine-readable snapshot", async () => {
  const loggedInfo: Array<{ event: string; context: Record<string, unknown> }> = [];
  const handler = createClaimsOperationsHandler({
    getAuthContextFn: async () => ADMIN_AUTH,
    loadDashboardOperationalSummaryFn: async () => ({
      totalClaims: 42,
      statusCounts: {
        NEW: 5,
        PROCESSING: 7,
        REVIEW_REQUIRED: 11,
        READY: 13,
        ERROR: 6,
      },
      staleProcessingCount: 3,
      operationalActivity: {
        windowHours: 24,
        watchdogRecoveryCount: 2,
        manualProcessingRecoveryCount: 1,
        manualRetryCount: 4,
      },
    }),
    nowFn: () => new Date("2026-03-07T12:00:00.000Z"),
    logInfoFn: (event, context) => {
      loggedInfo.push({ event, context });
    },
  });

  const response = await handler();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), {
    generatedAt: "2026-03-07T12:00:00.000Z",
    organizationId: "org-ops-test",
    organizationName: "Ops Test Org",
    totalClaims: 42,
    statusCounts: {
      NEW: 5,
      PROCESSING: 7,
      REVIEW_REQUIRED: 11,
      READY: 13,
      ERROR: 6,
    },
    staleProcessingCount: 3,
    operationalActivity: {
      windowHours: 24,
      watchdogRecoveryCount: 2,
      manualProcessingRecoveryCount: 1,
      manualRetryCount: 4,
    },
  });
  assert.deepEqual(loggedInfo, [
    {
      event: "claims_operations_snapshot_served",
      context: {
        organizationId: "org-ops-test",
        userId: "user-ops-test",
        staleProcessingCount: 3,
        watchdogRecoveryCount: 2,
        manualProcessingRecoveryCount: 1,
        manualRetryCount: 4,
      },
    },
  ]);
});

test("claims operations returns 500 and logs when snapshot loading fails", async () => {
  const capturedErrors: Array<{ error: unknown; context: Record<string, unknown> }> = [];
  const loggedErrors: Array<{ event: string; context: Record<string, unknown> }> = [];
  const handler = createClaimsOperationsHandler({
    getAuthContextFn: async () => ADMIN_AUTH,
    loadDashboardOperationalSummaryFn: async () => {
      throw new Error("simulated snapshot failure");
    },
    captureWebExceptionFn: (error, context) => {
      capturedErrors.push({ error, context });
    },
    logErrorFn: (event, context) => {
      loggedErrors.push({ event, context });
    },
  });

  const response = await handler();

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Unable to load claim operations snapshot",
  });
  assert.equal(capturedErrors.length, 1);
  assert.equal(loggedErrors.length, 1);
  assert.equal(loggedErrors[0]?.event, "claims_operations_snapshot_failed");
  assert.equal(loggedErrors[0]?.context.error, "simulated snapshot failure");
});
