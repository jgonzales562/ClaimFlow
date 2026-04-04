import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDashboardSummaryCacheHandlers,
  getDashboardSummaryCacheBucketIso,
} from "../apps/web/lib/claims/dashboard-summary-cache.ts";

test("dashboard summary cache reuses page and operational wrappers per organization", async () => {
  const unstableCacheCalls: Array<{
    keyParts: string[];
    tags: string[] | undefined;
  }> = [];
  const pageSummaryLoads: Array<{ organizationId: string; now: string }> = [];
  const operationalSummaryLoads: Array<{ organizationId: string; now: string }> = [];

  const handlers = createDashboardSummaryCacheHandlers({
    unstableCacheFn: ((loader, keyParts, options) => {
      unstableCacheCalls.push({
        keyParts: [...keyParts],
        tags: options?.tags,
      });
      return loader;
    }) as typeof import("next/cache").unstable_cache,
    loadDashboardPageSummaryFn: async ({ organizationId, now }) => {
      pageSummaryLoads.push({
        organizationId,
        now: now.toISOString(),
      });
      return {
        totalClaims: 0,
        statusCounts: {
          NEW: 0,
          PROCESSING: 0,
          REVIEW_REQUIRED: 0,
          READY: 0,
          ERROR: 0,
        },
        staleProcessingCount: 0,
        operationalActivity: {
          windowHours: 24,
          watchdogRecoveryCount: 0,
          manualProcessingRecoveryCount: 0,
          manualRetryCount: 0,
        },
      };
    },
    loadDashboardOperationalSummaryFn: async ({ organizationId, now }) => {
      operationalSummaryLoads.push({
        organizationId,
        now: now.toISOString(),
      });
      return {
        totalClaims: 0,
        statusCounts: {
          NEW: 0,
          PROCESSING: 0,
          REVIEW_REQUIRED: 0,
          READY: 0,
          ERROR: 0,
        },
        staleProcessingCount: 0,
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
      };
    },
  });

  const firstNow = new Date("2026-04-02T15:14:16.900Z");
  const secondNow = new Date("2026-04-02T15:14:18.100Z");
  const thirdNow = new Date("2026-04-02T15:14:21.300Z");

  await handlers.loadCachedDashboardPageSummary({
    organizationId: "org-a",
    now: firstNow,
  });
  await handlers.loadCachedDashboardPageSummary({
    organizationId: "org-a",
    now: secondNow,
  });
  await handlers.loadCachedDashboardPageSummary({
    organizationId: "org-b",
    now: thirdNow,
  });
  await handlers.loadCachedDashboardOperationalSummary({
    organizationId: "org-a",
    now: firstNow,
  });
  await handlers.loadCachedDashboardOperationalSummary({
    organizationId: "org-a",
    now: secondNow,
  });
  await handlers.loadCachedDashboardOperationalSummary({
    organizationId: "org-b",
    now: thirdNow,
  });

  assert.deepEqual(
    unstableCacheCalls.map((call) => ({
      keyParts: call.keyParts,
      tags: call.tags,
    })),
    [
      {
        keyParts: ["dashboard-page-summary", "org-a"],
        tags: ["dashboard-page-summary:org-a"],
      },
      {
        keyParts: ["dashboard-page-summary", "org-b"],
        tags: ["dashboard-page-summary:org-b"],
      },
      {
        keyParts: ["dashboard-operational-summary", "org-a"],
        tags: ["dashboard-operational-summary:org-a"],
      },
      {
        keyParts: ["dashboard-operational-summary", "org-b"],
        tags: ["dashboard-operational-summary:org-b"],
      },
    ],
  );

  assert.deepEqual(pageSummaryLoads, [
    {
      organizationId: "org-a",
      now: getDashboardSummaryCacheBucketIso(firstNow),
    },
    {
      organizationId: "org-a",
      now: getDashboardSummaryCacheBucketIso(secondNow),
    },
    {
      organizationId: "org-b",
      now: getDashboardSummaryCacheBucketIso(thirdNow),
    },
  ]);
  assert.deepEqual(operationalSummaryLoads, [
    {
      organizationId: "org-a",
      now: getDashboardSummaryCacheBucketIso(firstNow),
    },
    {
      organizationId: "org-a",
      now: getDashboardSummaryCacheBucketIso(secondNow),
    },
    {
      organizationId: "org-b",
      now: getDashboardSummaryCacheBucketIso(thirdNow),
    },
  ]);
});

test("dashboard summary cache revalidates page and operational tags for an organization", () => {
  const revalidatedTags: string[] = [];

  const handlers = createDashboardSummaryCacheHandlers({
    revalidateTagFn: ((tag) => {
      revalidatedTags.push(tag);
    }) as typeof import("next/cache").revalidateTag,
  });

  handlers.revalidateDashboardSummaryCache("org-cache");

  assert.deepEqual(revalidatedTags, [
    "dashboard-page-summary:org-cache",
    "dashboard-operational-summary:org-cache",
  ]);
});
