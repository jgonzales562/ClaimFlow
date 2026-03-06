import { prisma } from "@claimflow/db";
import type { Prisma } from "@prisma/client";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCachedAuthContext, hasMinimumRole } from "@/lib/auth/server";
import {
  applyTimestampCursor,
  encodeTimestampCursor,
  parsePageDirection,
  parseTimestampCursor,
  type PageDirection,
} from "@/lib/claims/cursor-pagination";
import {
  buildClaimWhereInput,
  CLAIM_STATUSES,
  formatDateInput,
  parseClaimFiltersFromRecord,
  readSearchParam,
  serializeFiltersToQueryParams,
} from "@/lib/claims/filters";
import { cx, formatTokenLabel, getClaimStatusTone, getWarrantyTone } from "@/lib/ui";

type DashboardPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const DASHBOARD_PAGE_SIZE = 100;
const numberFormatter = new Intl.NumberFormat("en-US");

type DashboardPageDirection = PageDirection;

const dashboardOrderByDesc: Prisma.ClaimOrderByWithRelationInput[] = [
  { createdAt: "desc" },
  { id: "desc" },
];

const dashboardOrderByAsc: Prisma.ClaimOrderByWithRelationInput[] = [
  { createdAt: "asc" },
  { id: "asc" },
];

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const auth = await getCachedAuthContext();
  if (!auth) {
    redirect("/login");
  }

  const canAccessErrorTriage = hasMinimumRole(auth.role, "ADMIN");
  const resolvedSearchParams = (await searchParams) ?? {};
  const filters = parseClaimFiltersFromRecord(resolvedSearchParams);
  const cursor = parseTimestampCursor(readSearchParam(resolvedSearchParams, "cursor"));
  const direction = parsePageDirection(readSearchParam(resolvedSearchParams, "direction"));

  const [claimsWindow, groupedCounts] = await Promise.all([
    prisma.claim.findMany({
      where: applyTimestampCursor(
        buildClaimWhereInput(auth.organizationId, filters),
        cursor,
        direction,
        "createdAt",
      ),
      orderBy: direction === "prev" ? dashboardOrderByAsc : dashboardOrderByDesc,
      take: DASHBOARD_PAGE_SIZE + 1,
      select: {
        id: true,
        externalClaimId: true,
        customerName: true,
        productName: true,
        status: true,
        warrantyStatus: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.claim.groupBy({
      by: ["status"],
      where: {
        organizationId: auth.organizationId,
      },
      _count: {
        _all: true,
      },
    }),
  ]);

  const statusCounts = groupedCounts.reduce<
    Partial<Record<(typeof CLAIM_STATUSES)[number], number>>
  >((result, entry) => {
    result[entry.status] = entry._count._all;
    return result;
  }, {});

  const totalClaims = groupedCounts.reduce((sum, entry) => sum + entry._count._all, 0);
  const reviewRequiredCount = statusCounts.REVIEW_REQUIRED ?? 0;
  const readyCount = statusCounts.READY ?? 0;
  const errorCount = statusCounts.ERROR ?? 0;
  const activeFilterCount = [
    filters.search,
    filters.status,
    filters.createdFrom,
    filters.createdTo,
  ].filter(Boolean).length;

  const hasMoreInDirection = claimsWindow.length > DASHBOARD_PAGE_SIZE;
  const pageSlice = hasMoreInDirection ? claimsWindow.slice(0, DASHBOARD_PAGE_SIZE) : claimsWindow;
  const claims = direction === "prev" ? [...pageSlice].reverse() : pageSlice;
  const first = claims[0] ?? null;
  const last = claims[claims.length - 1] ?? null;
  const nextCursor = last
    ? direction === "prev"
      ? encodeTimestampCursor({ timestamp: last.createdAt, id: last.id })
      : hasMoreInDirection
        ? encodeTimestampCursor({ timestamp: last.createdAt, id: last.id })
        : null
    : null;
  const prevCursor = first
    ? direction === "prev"
      ? hasMoreInDirection
        ? encodeTimestampCursor({ timestamp: first.createdAt, id: first.id })
        : null
      : cursor
        ? encodeTimestampCursor({ timestamp: first.createdAt, id: first.id })
        : null
    : null;

  const exportQueryParams = serializeFiltersToQueryParams(filters);
  exportQueryParams.set("limit", "1000");
  const csvExportHref = `/api/claims/export?${buildExportQuery(exportQueryParams, "csv")}`;
  const jsonExportHref = `/api/claims/export?${buildExportQuery(exportQueryParams, "json")}`;

  return (
    <main className="app-shell app-shell--wide page-stack">
      <section className="hero-card">
        <div>
          <p className="eyebrow">Claims operations</p>
          <h1 className="page-title">ClaimFlow Dashboard</h1>
          <p className="page-subtitle">
            Monitor intake volume, review readiness, and exceptions across {auth.organizationName}
            {"."}
          </p>
        </div>

        <div className="hero-meta">
          <div className="hero-details">
            <span className="hero-chip">{auth.organizationName}</span>
            <span className={cx("pill", "pill--info")}>{formatTokenLabel(auth.role)}</span>
          </div>

          <p className="hero-note">Signed in as {auth.email}</p>

          <div className="hero-actions">
            {canAccessErrorTriage ? (
              <Link href="/dashboard/errors" className="button button--secondary">
                Error Triage
              </Link>
            ) : null}

            <form action="/api/auth/logout" method="post">
              <button type="submit" className="button button--primary">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </section>

      <section className="stats-grid">
        <article className="stat-card">
          <p className="stat-label">Total claims</p>
          <strong className="stat-value">{numberFormatter.format(totalClaims)}</strong>
          <p className="stat-note">All recorded claims in the organization workspace.</p>
        </article>
        <article className="stat-card">
          <p className="stat-label">Needs review</p>
          <strong className="stat-value">{numberFormatter.format(reviewRequiredCount)}</strong>
          <p className="stat-note">Claims waiting on analyst review or missing information.</p>
        </article>
        <article className="stat-card">
          <p className="stat-label">Ready</p>
          <strong className="stat-value">{numberFormatter.format(readyCount)}</strong>
          <p className="stat-note">Claims ready to move forward without manual cleanup.</p>
        </article>
        <article className="stat-card">
          <p className="stat-label">Exceptions</p>
          <strong className="stat-value">{numberFormatter.format(errorCount)}</strong>
          <p className="stat-note">
            {canAccessErrorTriage
              ? "Open the triage queue for failures that need intervention."
              : "Claims currently in an error state."}
          </p>
        </article>
      </section>

      <section className="surface-card panel section-stack">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Search and export</p>
            <h2 className="section-title">Claim queue filters</h2>
            <p className="section-copy">
              Refine the queue by free-text search, status, or date range, then export the exact
              slice you are reviewing.
            </p>
          </div>
        </div>

        <form method="get" className="section-stack">
          <div className="dashboard-filter-primary">
            <label className="field-label">
              <span>Search</span>
              <input
                className="control"
                type="text"
                name="search"
                defaultValue={filters.search ?? ""}
                placeholder="Claim ID, customer, product, issue..."
              />
            </label>

            <label className="field-label">
              <span>Status</span>
              <select className="control" name="status" defaultValue={filters.status ?? ""}>
                <option value="">All statuses</option>
                {CLAIM_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {formatTokenLabel(status)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="dashboard-filter-secondary">
            <label className="field-label">
              <span>Created From</span>
              <input
                className="control"
                type="date"
                name="created_from"
                defaultValue={formatDateInput(filters.createdFrom)}
              />
            </label>

            <label className="field-label">
              <span>Created To</span>
              <input
                className="control"
                type="date"
                name="created_to"
                defaultValue={formatDateInput(filters.createdTo)}
              />
            </label>

            <div className="cluster">
              <button type="submit" className="button button--primary">
                Apply filters
              </button>
              <Link href="/dashboard" className="button button--secondary">
                Clear
              </Link>
            </div>

            <div className="cluster">
              <a href={csvExportHref} className="button button--secondary">
                Export CSV
              </a>
              <a href={jsonExportHref} className="button button--secondary">
                Export JSON
              </a>
            </div>
          </div>
        </form>
      </section>

      <section className="surface-card table-card">
        <div className="table-toolbar">
          <div>
            <p className="section-kicker">Live queue</p>
            <h2 className="section-title">Recent claims</h2>
            <p className="section-copy">
              Showing {numberFormatter.format(claims.length)} claims ordered by newest creation date
              first.
            </p>
          </div>
          <p className="section-copy">
            {activeFilterCount > 0
              ? `${numberFormatter.format(activeFilterCount)} active filter${
                  activeFilterCount === 1 ? "" : "s"
                }.`
              : "No filters applied."}
          </p>
        </div>

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Claim ID</th>
                <th>Customer</th>
                <th>Product</th>
                <th>Status</th>
                <th>Warranty</th>
                <th>Created</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {claims.length === 0 ? (
                <tr>
                  <td colSpan={7} className="empty-state">
                    No claims found for the selected filters.
                  </td>
                </tr>
              ) : (
                claims.map((claim) => (
                  <tr key={claim.id}>
                    <td>
                      <Link href={`/dashboard/claims/${claim.id}`} className="table-link">
                        {claim.externalClaimId ?? claim.id.slice(0, 10)}
                      </Link>
                    </td>
                    <td>{claim.customerName ?? "-"}</td>
                    <td>{claim.productName ?? "-"}</td>
                    <td>
                      <span className={cx("pill", `pill--${getClaimStatusTone(claim.status)}`)}>
                        {formatTokenLabel(claim.status)}
                      </span>
                    </td>
                    <td>
                      <span
                        className={cx("pill", `pill--${getWarrantyTone(claim.warrantyStatus)}`)}
                      >
                        {formatTokenLabel(claim.warrantyStatus)}
                      </span>
                    </td>
                    <td>{formatDateInput(claim.createdAt)}</td>
                    <td>{formatDateInput(claim.updatedAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {nextCursor || prevCursor ? (
        <div className="pagination-row">
          {prevCursor ? (
            <Link
              href={buildDashboardPageHref(filters, prevCursor, "prev")}
              className="button button--secondary"
            >
              Previous page
            </Link>
          ) : null}
          {nextCursor ? (
            <Link
              href={buildDashboardPageHref(filters, nextCursor, "next")}
              className="button button--secondary"
            >
              Next page
            </Link>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

function buildExportQuery(baseParams: URLSearchParams, format: "csv" | "json"): string {
  const copy = new URLSearchParams(baseParams);
  copy.set("format", format);
  return copy.toString();
}

function buildDashboardPageHref(
  filters: Parameters<typeof serializeFiltersToQueryParams>[0],
  cursor: string,
  direction: DashboardPageDirection,
): string {
  const params = serializeFiltersToQueryParams(filters);
  params.set("cursor", cursor);
  params.set("direction", direction);
  return `/dashboard?${params.toString()}`;
}
