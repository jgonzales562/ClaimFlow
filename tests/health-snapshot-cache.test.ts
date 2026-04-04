import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createClaimsHealthSnapshotCacheHandlers,
  getClaimsHealthCacheBucketIso,
} from "../apps/web/lib/claims/health-snapshot-cache.ts";

test("claims health snapshot cache reuses the same wrapper across calls", async () => {
  const unstableCacheCalls: Array<{
    keyParts: string[];
    tags: string[] | undefined;
  }> = [];
  const healthSnapshotLoads: string[] = [];

  const handlers = createClaimsHealthSnapshotCacheHandlers({
    unstableCacheFn: ((loader, keyParts, options) => {
      unstableCacheCalls.push({
        keyParts: [...keyParts],
        tags: options?.tags,
      });
      return loader;
    }) as typeof import("next/cache").unstable_cache,
    loadClaimsOperationsHealthSnapshotFn: async ({ now }) => {
      healthSnapshotLoads.push(now.toISOString());
      return {
        generatedAt: now,
        generatedAtIso: now.toISOString(),
        staleProcessing: {
          count: 0,
          oldestAgeMinutes: null,
        },
        errorBacklog: {
          totalCount: 0,
          oldestAgeMinutes: null,
          recentFailures24h: 0,
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
  const secondNow = new Date("2026-04-02T15:14:21.300Z");

  await handlers.loadCachedClaimsOperationsHealthSnapshot({
    now: firstNow,
  });
  await handlers.loadCachedClaimsOperationsHealthSnapshot({
    now: secondNow,
  });

  assert.deepEqual(unstableCacheCalls, [
    {
      keyParts: ["claims-health-snapshot"],
      tags: ["claims-health-snapshot"],
    },
  ]);
  assert.deepEqual(healthSnapshotLoads, [
    getClaimsHealthCacheBucketIso(firstNow),
    getClaimsHealthCacheBucketIso(secondNow),
  ]);
});

test("claims health snapshot cache revalidates the shared snapshot tag", () => {
  const revalidatedTags: string[] = [];

  const handlers = createClaimsHealthSnapshotCacheHandlers({
    revalidateTagFn: ((tag) => {
      revalidatedTags.push(tag);
    }) as typeof import("next/cache").revalidateTag,
  });

  handlers.revalidateClaimsHealthSnapshot();

  assert.deepEqual(revalidatedTags, ["claims-health-snapshot"]);
});
