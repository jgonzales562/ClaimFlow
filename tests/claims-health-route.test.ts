import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaimsHealthHandler } from "../apps/web/lib/claims/health-route.ts";

test("claims health returns 503 when the endpoint token is not configured", async () => {
  const handler = createClaimsHealthHandler({
    getBearerTokenFn: () => null,
  });

  const response = await handler(new Request("http://localhost/api/ops/claims/health"));

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Claims health endpoint is not configured",
  });
});

test("claims health rejects missing bearer tokens", async () => {
  const handler = createClaimsHealthHandler({
    getBearerTokenFn: () => "ops-secret-token",
  });

  const response = await handler(new Request("http://localhost/api/ops/claims/health"));

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), "Bearer");
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
});

test("claims health returns an ok snapshot for authorized monitors", async () => {
  const handler = createClaimsHealthHandler({
    getBearerTokenFn: () => "ops-secret-token",
    getMaxDueOutboxCountFn: () => 1,
    getMaxStaleProcessingCountFn: () => 2,
    getStaleMinutesFn: () => 30,
    isProcessingWatchdogEnabledFn: () => true,
    nowFn: () => new Date("2026-03-07T15:00:00.000Z"),
    loadClaimsOperationsHealthSnapshotFn: async () => ({
      totalClaims: 100,
      statusCounts: {
        NEW: 15,
        PROCESSING: 10,
        REVIEW_REQUIRED: 20,
        READY: 50,
        ERROR: 5,
      },
      staleProcessingCount: 2,
      staleProcessingOrganizationCount: 1,
      extractionConfig: {
        mode: "openai",
        openAiConfigured: true,
        heuristicFallbackAllowed: false,
      },
      operationalActivity: {
        windowHours: 24,
        watchdogRecoveryCount: 3,
        manualProcessingRecoveryCount: 2,
        manualRetryCount: 4,
      },
      ingestQueueOutbox: {
        pendingCount: 1,
        dueCount: 1,
        oldestPendingAgeMinutes: 4,
        oldestPendingCreatedAt: new Date("2026-03-07T14:56:00.000Z"),
        oldestDueAgeMinutes: 2,
        oldestDueAvailableAt: new Date("2026-03-07T14:58:00.000Z"),
      },
    }),
  });

  const response = await handler(
    new Request("http://localhost/api/ops/claims/health", {
      headers: {
        authorization: "Bearer ops-secret-token",
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), {
    generatedAt: "2026-03-07T15:00:00.000Z",
    status: "ok",
    summary: {
      totalClaims: 100,
      statusCounts: {
        NEW: 15,
        PROCESSING: 10,
        REVIEW_REQUIRED: 20,
        READY: 50,
        ERROR: 5,
      },
      staleProcessingCount: 2,
      staleProcessingOrganizationCount: 1,
      extractionConfig: {
        mode: "openai",
        openAiConfigured: true,
        heuristicFallbackAllowed: false,
      },
      operationalActivity: {
        windowHours: 24,
        watchdogRecoveryCount: 3,
        manualProcessingRecoveryCount: 2,
        manualRetryCount: 4,
      },
      ingestQueueOutbox: {
        pendingCount: 1,
        dueCount: 1,
        oldestPendingAgeMinutes: 4,
        oldestPendingCreatedAt: "2026-03-07T14:56:00.000Z",
        oldestDueAgeMinutes: 2,
        oldestDueAvailableAt: "2026-03-07T14:58:00.000Z",
      },
    },
    checks: {
      staleProcessing: {
        status: "ok",
        observedCount: 2,
        affectedOrganizations: 1,
        threshold: 2,
        staleAfterMinutes: 30,
      },
      ingestQueueOutbox: {
        status: "ok",
        pendingCount: 1,
        dueCount: 1,
        threshold: 1,
        oldestPendingAgeMinutes: 4,
        oldestDueAgeMinutes: 2,
      },
      extraction: {
        status: "ok",
        mode: "openai",
        openAiConfigured: true,
        heuristicFallbackAllowed: false,
      },
      processingWatchdog: {
        enabled: true,
      },
    },
  });
});

test("claims health returns 503 when stale processing breaches the threshold", async () => {
  const handler = createClaimsHealthHandler({
    getBearerTokenFn: () => "ops-secret-token",
    getMaxDueOutboxCountFn: () => 0,
    getMaxStaleProcessingCountFn: () => 0,
    getStaleMinutesFn: () => 45,
    isProcessingWatchdogEnabledFn: () => false,
    loadClaimsOperationsHealthSnapshotFn: async () => ({
      totalClaims: 9,
      statusCounts: {
        NEW: 0,
        PROCESSING: 3,
        REVIEW_REQUIRED: 2,
        READY: 3,
        ERROR: 1,
      },
      staleProcessingCount: 1,
      staleProcessingOrganizationCount: 1,
      extractionConfig: {
        mode: "openai",
        openAiConfigured: true,
        heuristicFallbackAllowed: false,
      },
      operationalActivity: {
        windowHours: 24,
        watchdogRecoveryCount: 0,
        manualProcessingRecoveryCount: 0,
        manualRetryCount: 0,
      },
      ingestQueueOutbox: {
        pendingCount: 2,
        dueCount: 1,
        oldestPendingAgeMinutes: 30,
        oldestPendingCreatedAt: new Date("2026-03-07T14:30:00.000Z"),
        oldestDueAgeMinutes: 12,
        oldestDueAvailableAt: new Date("2026-03-07T14:48:00.000Z"),
      },
    }),
  });

  const response = await handler(
    new Request("http://localhost/api/ops/claims/health", {
      headers: {
        authorization: "Bearer ops-secret-token",
      },
    }),
  );

  assert.equal(response.status, 503);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.status, "degraded");
  assert.deepEqual(body.checks, {
    staleProcessing: {
      status: "degraded",
      observedCount: 1,
      affectedOrganizations: 1,
      threshold: 0,
      staleAfterMinutes: 45,
    },
    ingestQueueOutbox: {
      status: "degraded",
      pendingCount: 2,
      dueCount: 1,
      threshold: 0,
      oldestPendingAgeMinutes: 30,
      oldestDueAgeMinutes: 12,
    },
    extraction: {
      status: "ok",
      mode: "openai",
      openAiConfigured: true,
      heuristicFallbackAllowed: false,
    },
    processingWatchdog: {
      enabled: false,
    },
  });
});

test("claims health returns 503 when heuristic fallback mode is active", async () => {
  const handler = createClaimsHealthHandler({
    getBearerTokenFn: () => "ops-secret-token",
    getMaxDueOutboxCountFn: () => 0,
    getMaxStaleProcessingCountFn: () => 0,
    getStaleMinutesFn: () => 30,
    isProcessingWatchdogEnabledFn: () => true,
    loadClaimsOperationsHealthSnapshotFn: async () => ({
      totalClaims: 3,
      statusCounts: {
        NEW: 1,
        PROCESSING: 0,
        REVIEW_REQUIRED: 1,
        READY: 1,
        ERROR: 0,
      },
      staleProcessingCount: 0,
      staleProcessingOrganizationCount: 0,
      extractionConfig: {
        mode: "heuristic_fallback",
        openAiConfigured: false,
        heuristicFallbackAllowed: true,
      },
      operationalActivity: {
        windowHours: 24,
        watchdogRecoveryCount: 0,
        manualProcessingRecoveryCount: 0,
        manualRetryCount: 0,
      },
      ingestQueueOutbox: {
        pendingCount: 0,
        dueCount: 0,
        oldestPendingAgeMinutes: null,
        oldestPendingCreatedAt: null,
        oldestDueAgeMinutes: null,
        oldestDueAvailableAt: null,
      },
    }),
  });

  const response = await handler(
    new Request("http://localhost/api/ops/claims/health", {
      headers: {
        authorization: "Bearer ops-secret-token",
      },
    }),
  );

  assert.equal(response.status, 503);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.status, "degraded");
  assert.deepEqual(body.checks, {
    staleProcessing: {
      status: "ok",
      observedCount: 0,
      affectedOrganizations: 0,
      threshold: 0,
      staleAfterMinutes: 30,
    },
    ingestQueueOutbox: {
      status: "ok",
      pendingCount: 0,
      dueCount: 0,
      threshold: 0,
      oldestPendingAgeMinutes: null,
      oldestDueAgeMinutes: null,
    },
    extraction: {
      status: "degraded",
      mode: "heuristic_fallback",
      openAiConfigured: false,
      heuristicFallbackAllowed: true,
    },
    processingWatchdog: {
      enabled: true,
    },
  });
});

test("claims health returns 500 and logs when snapshot loading fails", async () => {
  const capturedErrors: Array<{ error: unknown; context: Record<string, unknown> }> = [];
  const loggedErrors: Array<{ event: string; context: Record<string, unknown> }> = [];
  const handler = createClaimsHealthHandler({
    getBearerTokenFn: () => "ops-secret-token",
    loadClaimsOperationsHealthSnapshotFn: async () => {
      throw new Error("simulated health failure");
    },
    captureWebExceptionFn: (error, context) => {
      capturedErrors.push({ error, context });
    },
    logErrorFn: (event, context) => {
      loggedErrors.push({ event, context });
    },
  });

  const response = await handler(
    new Request("http://localhost/api/ops/claims/health", {
      headers: {
        authorization: "Bearer ops-secret-token",
      },
    }),
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Unable to load claims health snapshot",
  });
  assert.equal(capturedErrors.length, 1);
  assert.deepEqual(capturedErrors[0]?.context, {
    route: "/api/ops/claims/health",
  });
  assert.equal(loggedErrors.length, 1);
  assert.equal(loggedErrors[0]?.event, "claims_health_snapshot_failed");
  assert.equal(loggedErrors[0]?.context.error, "simulated health failure");
});
