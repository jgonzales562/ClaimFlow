import { unstable_cache } from "next/cache";
import { createClaimsOperationsHandler } from "@/lib/claims/operations-route";
import { loadDashboardOperationalSummary } from "@/lib/claims/dashboard-claims";

const CLAIMS_OPERATIONS_CACHE_WINDOW_MS = 5_000;

const loadCachedDashboardOperationalSummary = unstable_cache(
  async (organizationId: string, bucketIso: string) =>
    loadDashboardOperationalSummary({
      organizationId,
      now: new Date(bucketIso),
    }),
  ["claims-operations-summary"],
  { revalidate: 5 },
);

const claimsOperationsHandler = createClaimsOperationsHandler({
  loadDashboardOperationalSummaryFn: async (input) =>
    loadCachedDashboardOperationalSummary(
      input.organizationId,
      getClaimsOperationsCacheBucketIso(input.now),
    ),
});

export async function GET(): Promise<Response> {
  return claimsOperationsHandler();
}

function getClaimsOperationsCacheBucketIso(now?: Date): string {
  const timestamp = now?.getTime() ?? Date.now();
  return new Date(
    Math.floor(timestamp / CLAIMS_OPERATIONS_CACHE_WINDOW_MS) *
      CLAIMS_OPERATIONS_CACHE_WINDOW_MS,
  ).toISOString();
}
