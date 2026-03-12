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
  parsePageDirection,
  parseTimestampCursor,
} from "@/lib/claims/cursor-pagination";
import { listDashboardClaims } from "@/lib/claims/dashboard-claims";
import {
  CLAIM_STATUSES,
  formatDateInput,
  parseClaimFiltersFromRecord,
  readSearchParam,
} from "@/lib/claims/filters";
import { buildClaimCursorHref, buildClaimsExportHref } from "@/lib/claims/query-links";
import {
  formatClaimReference,
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

  const {
    claims,
    totalClaims,
    statusCounts,
    staleProcessingCount,
    operationalActivity,
    nextCursor,
    prevCursor,
  } =
    await listDashboardClaims({
      organizationId: auth.organizationId,
      filters,
      cursor,
      direction,
      pageSize: DASHBOARD_PAGE_SIZE,
    });

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
  const csvExportHref = buildClaimsExportHref(filters, "csv", 1000);
  const jsonExportHref = buildClaimsExportHref(filters, "json", 1000);

  return (
    <main className="app-shell app-shell--wide app-shell--ops page-stack">
      <PageHero
        compact
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

      {staleProcessingCount > 0 ? (
        <PanelSection
          kicker="Operational alert"
          title="Stalled intake requires review"
          copy={`${numberFormatter.format(staleProcessingCount)} stalled processing claim${
            staleProcessingCount === 1 ? " is" : "s are"
          } currently flagged. ${numberFormatter.format(
            operationalActivity.watchdogRecoveryCount,
          )} automatic recover${
            operationalActivity.watchdogRecoveryCount === 1 ? "y" : "ies"
          } and ${numberFormatter.format(
            operationalActivity.manualProcessingRecoveryCount,
          )} manual processing recover${
            operationalActivity.manualProcessingRecoveryCount === 1 ? "y" : "ies"
          } were recorded in the last ${operationalActivity.windowHours} hours.`}
          accessory={<Pill tone="warning">Attention needed</Pill>}
        >
          <p className="section-copy copy-reset">
            Review processing claims flagged with recovery availability to decide whether they
            should be re-queued or investigated further.
          </p>
        </PanelSection>
      ) : null}

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
              copy={`${numberFormatter.format(intakeCount)} claims are still in new or processing states, including ${numberFormatter.format(staleProcessingCount)} stalled in processing.`}
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
        kicker="Recovery pressure"
        title="Operational recovery activity"
        copy={`Recent recovery counters across the last ${operationalActivity.windowHours} hours, useful for spotting stuck intake and manual intervention pressure.`}
      >
        <div className="glance-grid">
          <GlanceCard
            tone={staleProcessingCount > 0 ? "warning" : "success"}
            label="Stalled intake"
            value={numberFormatter.format(staleProcessingCount)}
            copy={
              staleProcessingCount > 0
                ? "Claims are still in processing beyond the stale threshold and should be inspected for recovery."
                : "No claims are currently stalled in processing."
            }
          />
          <GlanceCard
            tone={operationalActivity.watchdogRecoveryCount > 0 ? "warning" : "neutral"}
            label="Automatic recoveries"
            value={numberFormatter.format(operationalActivity.watchdogRecoveryCount)}
            copy="Claims the watchdog re-enqueued after detecting stale processing."
          />
          <GlanceCard
            tone={operationalActivity.manualProcessingRecoveryCount > 0 ? "info" : "neutral"}
            label="Manual recoveries"
            value={numberFormatter.format(operationalActivity.manualProcessingRecoveryCount)}
            copy="Claims operators manually re-queued from stalled processing."
          />
          <GlanceCard
            tone={operationalActivity.manualRetryCount > 0 ? "info" : "neutral"}
            label="Manual retries"
            value={numberFormatter.format(operationalActivity.manualRetryCount)}
            copy={
              operationalActivity.manualRetryCount > 0
                ? "Retry actions taken against errored claims during the current recovery window."
                : "No manual retries have been recorded during the current recovery window."
            }
          />
        </div>
      </PanelSection>

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
                  <tr
                    key={claim.id}
                    className={`data-row data-row--${claim.isProcessingStale ? "warning" : getClaimStatusTone(claim.status)}`}
                  >
                    <td data-label="Claim ID">
                      <Link href={`/dashboard/claims/${claim.id}`} className="table-link mono-text">
                        {formatClaimReference(claim.externalClaimId, claim.id)}
                      </Link>
                    </td>
                    <td data-label="Customer">{claim.customerName ?? "-"}</td>
                    <td data-label="Product">{claim.productName ?? "-"}</td>
                    <td data-label="Status">
                      <Pill tone={getClaimStatusTone(claim.status)}>
                        {formatTokenLabel(claim.status)}
                      </Pill>
                      {claim.isProcessingStale ? (
                        <div className="subtle-text">Recovery available</div>
                      ) : null}
                    </td>
                    <td data-label="Warranty">
                      <Pill tone={getWarrantyTone(claim.warrantyStatus)}>
                        {formatTokenLabel(claim.warrantyStatus)}
                      </Pill>
                    </td>
                    <td data-label="Created">
                      <span className="mono-text mono-text--quiet">
                        {formatDateInput(claim.createdAt)}
                      </span>
                    </td>
                    <td data-label="Updated">
                      <span className="mono-text mono-text--quiet">
                        {formatDateInput(claim.updatedAt)}
                      </span>
                    </td>
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
              href={buildClaimCursorHref("/dashboard", filters, prevCursor, "prev")}
              className="button button--secondary"
            >
              Previous page
            </Link>
          ) : null}
          {nextCursor ? (
            <Link
              href={buildClaimCursorHref("/dashboard", filters, nextCursor, "next")}
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
