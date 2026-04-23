import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSummary, executeClaimsHealthCheck } from "../scripts/check-claims-health.mjs";

test("claims health check returns success details for healthy responses", async () => {
  const result = await executeClaimsHealthCheck({
    env: {
      CLAIMS_HEALTHCHECK_URL: "https://claimflow.example.com/api/ops/claims/health",
      CLAIMS_HEALTH_BEARER_TOKEN: "health-secret",
    },
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          status: "ok",
          checks: {
            staleProcessing: {
              observedCount: 0,
              affectedOrganizations: 0,
            },
            ingestQueueOutbox: {
              dueCount: 0,
              oldestDueAgeMinutes: null,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(
    result.summary,
    "Claims health OK | 0 stale processing claims across 0 organizations | 0 due outbox rows | status=ok",
  );
});

test("claims health check returns failure details for degraded responses", async () => {
  const result = await executeClaimsHealthCheck({
    env: {
      CLAIMS_HEALTHCHECK_URL: "https://claimflow.example.com/api/ops/claims/health",
      CLAIMS_HEALTH_BEARER_TOKEN: "health-secret",
    },
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          status: "degraded",
          checks: {
            staleProcessing: {
              observedCount: 2,
              affectedOrganizations: 1,
            },
            ingestQueueOutbox: {
              dueCount: 3,
              oldestDueAgeMinutes: 18,
            },
            extraction: {
              status: "degraded",
              mode: "heuristic_fallback",
            },
          },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      ),
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(
    result.summary,
    "Claims health check failed with 503 | status=degraded | 2 stale processing claims across 1 organizations | 3 due outbox rows (oldest 18m) | extraction=heuristic_fallback",
  );
});

test("claims health check surfaces endpoint errors from the response body", () => {
  assert.equal(
    buildSummary(500, { error: "Unable to load claims health snapshot" }),
    "Claims health check failed with 500 | Unable to load claims health snapshot",
  );
});

test("claims health check fails fast when required env vars are missing", async () => {
  await assert.rejects(
    () =>
      executeClaimsHealthCheck({
        env: {},
        fetchFn: async () => new Response(null, { status: 200 }),
      }),
    /CLAIMS_HEALTHCHECK_URL is required/,
  );
});
