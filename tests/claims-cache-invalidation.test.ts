import assert from "node:assert/strict";
import { test } from "node:test";
import { revalidateClaimsOperationsCaches } from "../apps/web/lib/claims/cache-invalidation.ts";

test("claims operations cache invalidation refreshes dashboard and health caches", () => {
  const calls: Array<{ type: "dashboard" | "health"; organizationId?: string }> = [];

  revalidateClaimsOperationsCaches("org-cache-test", {
    revalidateDashboardSummaryCacheFn: (organizationId) => {
      calls.push({
        type: "dashboard",
        organizationId,
      });
    },
    revalidateClaimsHealthSnapshotFn: () => {
      calls.push({
        type: "health",
      });
    },
  });

  assert.deepEqual(calls, [
    {
      type: "dashboard",
      organizationId: "org-cache-test",
    },
    {
      type: "health",
    },
  ]);
});
