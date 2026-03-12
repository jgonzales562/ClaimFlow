import { unstable_cache } from "next/cache";
import { createClaimsHealthHandler } from "@/lib/claims/health-route";
import { loadClaimsOperationsHealthSnapshot } from "@/lib/claims/operations-health";

const CLAIMS_HEALTH_CACHE_WINDOW_MS = 5_000;

const loadCachedClaimsOperationsHealthSnapshot = unstable_cache(
  async (bucketIso: string) =>
    loadClaimsOperationsHealthSnapshot({
      now: new Date(bucketIso),
    }),
  ["claims-health-snapshot"],
  { revalidate: 5 },
);

const claimsHealthHandler = createClaimsHealthHandler({
  loadClaimsOperationsHealthSnapshotFn: async (input = {}) =>
    loadCachedClaimsOperationsHealthSnapshot(
      getClaimsHealthCacheBucketIso(input.now),
    ),
});

export async function GET(request: Request): Promise<Response> {
  return claimsHealthHandler(request);
}

function getClaimsHealthCacheBucketIso(now?: Date): string {
  const timestamp = now?.getTime() ?? Date.now();
  return new Date(
    Math.floor(timestamp / CLAIMS_HEALTH_CACHE_WINDOW_MS) *
      CLAIMS_HEALTH_CACHE_WINDOW_MS,
  ).toISOString();
}
