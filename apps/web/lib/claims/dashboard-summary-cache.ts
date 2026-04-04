import { revalidateTag, unstable_cache } from "next/cache";
import {
  loadDashboardOperationalSummary,
  loadDashboardPageSummary,
  type DashboardOperationalSummary,
  type DashboardPageSummary,
} from "./dashboard-claims";

const DASHBOARD_SUMMARY_CACHE_WINDOW_MS = 5_000;
const DASHBOARD_PAGE_SUMMARY_TAG_PREFIX = "dashboard-page-summary";
const DASHBOARD_OPERATIONAL_SUMMARY_TAG_PREFIX = "dashboard-operational-summary";

type DashboardSummaryCacheLoader<T> = (bucketIso: string) => Promise<T>;
type DashboardSummaryCacheDependencies = {
  unstableCacheFn?: typeof unstable_cache;
  revalidateTagFn?: typeof revalidateTag;
  loadDashboardPageSummaryFn?: typeof loadDashboardPageSummary;
  loadDashboardOperationalSummaryFn?: typeof loadDashboardOperationalSummary;
};

export function createDashboardSummaryCacheHandlers(
  dependencies: DashboardSummaryCacheDependencies = {},
) {
  const unstableCacheFn = dependencies.unstableCacheFn ?? unstable_cache;
  const revalidateTagFn = dependencies.revalidateTagFn ?? revalidateTag;
  const loadDashboardPageSummaryFn =
    dependencies.loadDashboardPageSummaryFn ?? loadDashboardPageSummary;
  const loadDashboardOperationalSummaryFn =
    dependencies.loadDashboardOperationalSummaryFn ?? loadDashboardOperationalSummary;
  const pageSummaryLoaders = new Map<string, DashboardSummaryCacheLoader<DashboardPageSummary>>();
  const operationalSummaryLoaders = new Map<
    string,
    DashboardSummaryCacheLoader<DashboardOperationalSummary>
  >();

  const getPageSummaryLoader = (
    organizationId: string,
  ): DashboardSummaryCacheLoader<DashboardPageSummary> => {
    const existingLoader = pageSummaryLoaders.get(organizationId);
    if (existingLoader) {
      return existingLoader;
    }

    const loader = unstableCacheFn(
      async (bucketIso: string) =>
        loadDashboardPageSummaryFn({
          organizationId,
          now: new Date(bucketIso),
        }),
      [DASHBOARD_PAGE_SUMMARY_TAG_PREFIX, organizationId],
      {
        tags: [getDashboardPageSummaryTag(organizationId)],
        revalidate: 5,
      },
    ) as DashboardSummaryCacheLoader<DashboardPageSummary>;
    pageSummaryLoaders.set(organizationId, loader);
    return loader;
  };

  const getOperationalSummaryLoader = (
    organizationId: string,
  ): DashboardSummaryCacheLoader<DashboardOperationalSummary> => {
    const existingLoader = operationalSummaryLoaders.get(organizationId);
    if (existingLoader) {
      return existingLoader;
    }

    const loader = unstableCacheFn(
      async (bucketIso: string) =>
        loadDashboardOperationalSummaryFn({
          organizationId,
          now: new Date(bucketIso),
        }),
      [DASHBOARD_OPERATIONAL_SUMMARY_TAG_PREFIX, organizationId],
      {
        tags: [getDashboardOperationalSummaryTag(organizationId)],
        revalidate: 5,
      },
    ) as DashboardSummaryCacheLoader<DashboardOperationalSummary>;
    operationalSummaryLoaders.set(organizationId, loader);
    return loader;
  };

  return {
    loadCachedDashboardPageSummary(input: {
      organizationId: string;
      now?: Date;
    }): Promise<DashboardPageSummary> {
      return getPageSummaryLoader(input.organizationId)(
        getDashboardSummaryCacheBucketIso(input.now),
      );
    },
    loadCachedDashboardOperationalSummary(input: {
      organizationId: string;
      now?: Date;
    }): Promise<DashboardOperationalSummary> {
      return getOperationalSummaryLoader(input.organizationId)(
        getDashboardSummaryCacheBucketIso(input.now),
      );
    },
    revalidateDashboardSummaryCache(organizationId: string): void {
      revalidateTagFn(getDashboardPageSummaryTag(organizationId));
      revalidateTagFn(getDashboardOperationalSummaryTag(organizationId));
    },
  };
}

const defaultDashboardSummaryCacheHandlers = createDashboardSummaryCacheHandlers();

export const loadCachedDashboardPageSummary =
  defaultDashboardSummaryCacheHandlers.loadCachedDashboardPageSummary;

export const loadCachedDashboardOperationalSummary =
  defaultDashboardSummaryCacheHandlers.loadCachedDashboardOperationalSummary;

export function getDashboardSummaryCacheBucketIso(now?: Date): string {
  const timestamp = now?.getTime() ?? Date.now();
  return new Date(
    Math.floor(timestamp / DASHBOARD_SUMMARY_CACHE_WINDOW_MS) *
      DASHBOARD_SUMMARY_CACHE_WINDOW_MS,
  ).toISOString();
}

export function revalidateDashboardSummaryCache(organizationId: string): void {
  defaultDashboardSummaryCacheHandlers.revalidateDashboardSummaryCache(organizationId);
}

function getDashboardPageSummaryTag(organizationId: string): string {
  return `${DASHBOARD_PAGE_SUMMARY_TAG_PREFIX}:${organizationId}`;
}

function getDashboardOperationalSummaryTag(organizationId: string): string {
  return `${DASHBOARD_OPERATIONAL_SUMMARY_TAG_PREFIX}:${organizationId}`;
}
