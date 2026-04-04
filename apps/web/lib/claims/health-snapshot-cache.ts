import { revalidateTag, unstable_cache } from "next/cache";
import {
  loadClaimsOperationsHealthSnapshot,
  type ClaimsOperationsHealthSnapshot,
} from "./operations-health";

const CLAIMS_HEALTH_CACHE_WINDOW_MS = 5_000;
const CLAIMS_HEALTH_SNAPSHOT_TAG = "claims-health-snapshot";

type ClaimsHealthSnapshotCacheLoader = (
  bucketIso: string,
) => Promise<ClaimsOperationsHealthSnapshot>;
type ClaimsHealthSnapshotCacheDependencies = {
  unstableCacheFn?: typeof unstable_cache;
  revalidateTagFn?: typeof revalidateTag;
  loadClaimsOperationsHealthSnapshotFn?: typeof loadClaimsOperationsHealthSnapshot;
};

export function createClaimsHealthSnapshotCacheHandlers(
  dependencies: ClaimsHealthSnapshotCacheDependencies = {},
) {
  const unstableCacheFn = dependencies.unstableCacheFn ?? unstable_cache;
  const revalidateTagFn = dependencies.revalidateTagFn ?? revalidateTag;
  const loadClaimsOperationsHealthSnapshotFn =
    dependencies.loadClaimsOperationsHealthSnapshotFn ?? loadClaimsOperationsHealthSnapshot;
  let snapshotLoader: ClaimsHealthSnapshotCacheLoader | null = null;

  const getSnapshotLoader = (): ClaimsHealthSnapshotCacheLoader => {
    if (snapshotLoader) {
      return snapshotLoader;
    }

    snapshotLoader = unstableCacheFn(
      async (bucketIso: string) =>
        loadClaimsOperationsHealthSnapshotFn({
          now: new Date(bucketIso),
        }),
      [CLAIMS_HEALTH_SNAPSHOT_TAG],
      {
        tags: [CLAIMS_HEALTH_SNAPSHOT_TAG],
        revalidate: 5,
      },
    ) as ClaimsHealthSnapshotCacheLoader;
    return snapshotLoader;
  };

  return {
    loadCachedClaimsOperationsHealthSnapshot(input: {
      now?: Date;
    } = {}): Promise<ClaimsOperationsHealthSnapshot> {
      return getSnapshotLoader()(getClaimsHealthCacheBucketIso(input.now));
    },
    revalidateClaimsHealthSnapshot(): void {
      revalidateTagFn(CLAIMS_HEALTH_SNAPSHOT_TAG);
    },
  };
}

const defaultClaimsHealthSnapshotCacheHandlers = createClaimsHealthSnapshotCacheHandlers();

export const loadCachedClaimsOperationsHealthSnapshot =
  defaultClaimsHealthSnapshotCacheHandlers.loadCachedClaimsOperationsHealthSnapshot;

export function getClaimsHealthCacheBucketIso(now?: Date): string {
  const timestamp = now?.getTime() ?? Date.now();
  return new Date(
    Math.floor(timestamp / CLAIMS_HEALTH_CACHE_WINDOW_MS) *
      CLAIMS_HEALTH_CACHE_WINDOW_MS,
  ).toISOString();
}

export function revalidateClaimsHealthSnapshot(): void {
  defaultClaimsHealthSnapshotCacheHandlers.revalidateClaimsHealthSnapshot();
}
