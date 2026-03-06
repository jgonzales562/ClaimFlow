import { prisma } from "@claimflow/db";
import type { Prisma } from "@prisma/client";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  GlanceCard,
  PageHero,
  PanelSection,
  Pill,
  StatCard,
  TableSection,
  WorkflowMeter,
} from "@/components/ui/dashboard";
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
import {
  formatPercent,
  formatTokenLabel,
  getClaimStatusTone,
  getWarrantyTone,
  toPercent,
} from "@/lib/ui";

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
  const newCount = statusCounts.NEW ?? 0;
  const processingCount = statusCounts.PROCESSING ?? 0;
  const reviewRequiredCount = statusCounts.REVIEW_REQUIRED ?? 0;
  const readyCount = statusCounts.READY ?? 0;
  const errorCount = statusCounts.ERROR ?? 0;
  const intakeCount = newCount + processingCount;
  const activeFilterCount = [
    filters.search,
    filters.status,
    filters.createdFrom,
    filters.createdTo,
  ].filter(Boolean).length;
  const workflowBreakdown = CLAIM_STATUSES.map((status) => {
    const count = statusCounts[status] ?? 0;
    return {
      status,
      label: formatTokenLabel(status),
      count,
      percent: toPercent(count, totalClaims),
      tone: getClaimStatusTone(status),
    };
  });
  const dominantStage = workflowBreakdown.reduce(
    (current, entry) => (entry.count > current.count ? entry : current),
    workflowBreakdown[0] ?? {
      status: "NEW",
      label: "No claims",
      count: 0,
      percent: 0,
      tone: "neutral" as const,
    },
  );
  const intakeShare = toPercent(intakeCount, totalClaims);
  const reviewLoadShare = toPercent(reviewRequiredCount + errorCount, totalClaims);
  const readyShare = toPercent(readyCount, totalClaims);

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
      <PageHero
        eyebrow="Claims operations"
        title="ClaimFlow Dashboard"
        subtitle={`Monitor intake volume, review readiness, and exceptions across ${auth.organizationName}.`}
        meta={
          <>
            <span className="hero-chip">{auth.organizationName}</span>
            <Pill tone="info">{formatTokenLabel(auth.role)}</Pill>
          </>
        }
        note={`Signed in as ${auth.email}`}
        actions={
          <>
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
          </>
        }
      />

      <section className="stats-grid">
        <StatCard
          label="Total claims"
          value={numberFormatter.format(totalClaims)}
          note="All recorded claims in the organization workspace."
        />
        <StatCard
          label="Needs review"
          value={numberFormatter.format(reviewRequiredCount)}
          note="Claims waiting on analyst review or missing information."
        />
        <StatCard
          label="Ready"
          value={numberFormatter.format(readyCount)}
          note="Claims ready to move forward without manual cleanup."
        />
        <StatCard
          label="Exceptions"
          value={numberFormatter.format(errorCount)}
          note={
            canAccessErrorTriage
              ? "Open the triage queue for failures that need intervention."
              : "Claims currently in an error state."
          }
        />
      </section>

      <section className="insight-grid">
        <PanelSection
          kicker="Workflow mix"
          title="Queue distribution"
          copy="Status mix across the entire organization queue, useful for spotting where work is pooling before you drill into individual claims."
        >
          <div className="workflow-list">
            {workflowBreakdown.map((entry) => (
              <WorkflowMeter
                key={entry.status}
                label={entry.label}
                meta={`${numberFormatter.format(entry.count)} claim${entry.count === 1 ? "" : "s"}`}
                percent={entry.percent}
                tone={entry.tone}
              />
            ))}
          </div>
        </PanelSection>

        <PanelSection
          kicker="Operating picture"
          title="At-a-glance posture"
          copy="A quick read on how much of the queue is still in intake, under manual attention, or ready to move forward."
        >
          <div className="glance-grid">
            <GlanceCard
              tone="info"
              label="Intake share"
              value={formatPercent(intakeShare)}
              copy={`${numberFormatter.format(intakeCount)} claims are still in new or processing states.`}
            />
            <GlanceCard
              tone={dominantStage.count > 0 ? dominantStage.tone : "neutral"}
              label="Dominant stage"
              value={dominantStage.count > 0 ? dominantStage.label : "No claims"}
              copy={
                dominantStage.count > 0
                  ? `${numberFormatter.format(dominantStage.count)} claims currently sit in the largest queue segment.`
                  : "No claims have been recorded yet."
              }
            />
            <GlanceCard
              tone="warning"
              label="Analyst load"
              value={formatPercent(reviewLoadShare)}
              copy={`${numberFormatter.format(reviewRequiredCount + errorCount)} claims either need review or are blocked by an exception.`}
            />
            <GlanceCard
              tone="success"
              label="Ready rate"
              value={formatPercent(readyShare)}
              copy={`${numberFormatter.format(readyCount)} claims are ready to move without more cleanup.`}
            />
          </div>
        </PanelSection>
      </section>

      <PanelSection
        kicker="Search and export"
        title="Claim queue filters"
        copy="Refine the queue by free-text search, status, or date range, then export the exact slice you are reviewing."
      >
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
      </PanelSection>

      <TableSection
        kicker="Live queue"
        title="Recent claims"
        copy={`Showing ${numberFormatter.format(claims.length)} claims ordered by newest creation date first.`}
        aside={
          <p className="section-copy">
            {activeFilterCount > 0
              ? `${numberFormatter.format(activeFilterCount)} active filter${
                  activeFilterCount === 1 ? "" : "s"
                }.`
              : "No filters applied."}
          </p>
        }
      >
        <div className="table-scroll">
          <table className="data-table data-table--responsive">
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
                    <td data-label="Claim ID">
                      <Link href={`/dashboard/claims/${claim.id}`} className="table-link">
                        {claim.externalClaimId ?? claim.id.slice(0, 10)}
                      </Link>
                    </td>
                    <td data-label="Customer">{claim.customerName ?? "-"}</td>
                    <td data-label="Product">{claim.productName ?? "-"}</td>
                    <td data-label="Status">
                      <Pill tone={getClaimStatusTone(claim.status)}>
                        {formatTokenLabel(claim.status)}
                      </Pill>
                    </td>
                    <td data-label="Warranty">
                      <Pill tone={getWarrantyTone(claim.warrantyStatus)}>
                        {formatTokenLabel(claim.warrantyStatus)}
                      </Pill>
                    </td>
                    <td data-label="Created">{formatDateInput(claim.createdAt)}</td>
                    <td data-label="Updated">{formatDateInput(claim.updatedAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </TableSection>

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
