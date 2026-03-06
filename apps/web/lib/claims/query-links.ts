import type { PageDirection } from "./cursor-pagination";
import { serializeFiltersToQueryParams, type ClaimFilters } from "./filters";

type QueryParamValue = string | number | null | undefined;

export function buildClaimListHref(
  pathname: string,
  filters: ClaimFilters,
  extraParams: Record<string, QueryParamValue> = {},
): string {
  const params = serializeFiltersToQueryParams(filters);

  for (const [key, value] of Object.entries(extraParams)) {
    if (value == null) {
      continue;
    }

    params.set(key, String(value));
  }

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function buildClaimCursorHref(
  pathname: string,
  filters: ClaimFilters,
  cursor: string,
  direction: PageDirection,
  extraParams: Record<string, QueryParamValue> = {},
): string {
  return buildClaimListHref(pathname, filters, {
    ...extraParams,
    cursor,
    direction,
  });
}

export function buildClaimsExportHref(
  filters: ClaimFilters,
  format: "csv" | "json",
  limit: number,
): string {
  return buildClaimListHref("/api/claims/export", filters, {
    format,
    limit,
  });
}
