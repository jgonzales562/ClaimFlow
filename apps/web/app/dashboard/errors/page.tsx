import Link from "next/link";
import { redirect } from "next/navigation";
import { getCachedAuthContext, hasMinimumRole } from "@/lib/auth/server";
import {
  clampLimit,
  formatDateInput,
  parseClaimFiltersFromRecord,
  readSearchParam,
  serializeFiltersToQueryParams,
} from "@/lib/claims/filters";
import { formatUtcDateTime } from "@/lib/format";
import {
  listErrorClaims,
  parseErrorClaimsCursor,
  parseErrorClaimsPageDirection,
  type ErrorClaimsPageDirection,
} from "@/lib/claims/error-claims";
import { cx, formatTokenLabel, getBooleanTone, getClaimStatusTone } from "@/lib/ui";

type ErrorClaimsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type ErrorClaimsResponse = Awaited<ReturnType<typeof listErrorClaims>>;

export default async function ErrorClaimsPage({ searchParams }: ErrorClaimsPageProps) {
  const auth = await getCachedAuthContext();
  if (!auth) {
    redirect("/login");
  }

  if (!hasMinimumRole(auth.role, "ADMIN")) {
    redirect("/dashboard?error=forbidden");
  }

  const resolvedSearchParams = (await searchParams) ?? {};
  const parsedFilters = parseClaimFiltersFromRecord(resolvedSearchParams);
  const limitParam = readSearchParam(resolvedSearchParams, "limit");
  const cursorParam = readSearchParam(resolvedSearchParams, "cursor");
  const directionParam = readSearchParam(resolvedSearchParams, "direction");
  const cursor = parseErrorClaimsCursor(cursorParam);
  const direction = parseErrorClaimsPageDirection(directionParam);
  const filters = {
    search: parsedFilters.search,
    createdFrom: parsedFilters.createdFrom,
    createdTo: parsedFilters.createdTo,
    limit: clampLimit(limitParam, 50, 1, 200),
  };

  let payload: ErrorClaimsResponse | null = null;
  let loadError: string | null = null;

  try {
    payload = await listErrorClaims({
      organizationId: auth.organizationId,
      filters: parsedFilters,
      limit: filters.limit,
      cursor,
      direction,
    });
  } catch {
    loadError = "Unable to load error claims.";
  }

  const pageClaims = payload?.claims ?? [];
  const retryableCount = pageClaims.filter((claim) => claim.failure?.retryable === true).length;
  const nonRetryableCount = pageClaims.filter((claim) => claim.failure?.retryable === false).length;
  const unknownRetryabilityCount = pageClaims.filter(
    (claim) => claim.failure?.retryable == null,
  ).length;
  const highestReceiveCount = pageClaims.reduce((highest, claim) => {
    const current = claim.failure?.receiveCount ?? 0;
    return current > highest ? current : highest;
  }, 0);
  const retryabilityBreakdown = [
    {
      label: "Retryable",
      count: retryableCount,
      percent: toPercent(retryableCount, pageClaims.length),
      tone: "success",
    },
    {
      label: "Non-retryable",
      count: nonRetryableCount,
      percent: toPercent(nonRetryableCount, pageClaims.length),
      tone: "danger",
    },
    {
      label: "Unknown",
      count: unknownRetryabilityCount,
      percent: toPercent(unknownRetryabilityCount, pageClaims.length),
      tone: "neutral",
    },
  ] as const;

  return (
    <main className="app-shell app-shell--wide page-stack">
      <section className="hero-card">
        <div>
          <p className="hero-breadcrumb">
            <Link href="/dashboard" className="hero-link">
              Back to dashboard
            </Link>
          </p>
          <p className="eyebrow">Exception handling</p>
          <h1 className="page-title">Error Claim Triage</h1>
          <p className="page-subtitle">
            Review failed claims, inspect the failure reason, and move anything retryable back into
            the queue with context.
          </p>
        </div>

        <div className="hero-meta">
          <div className="hero-details">
            <span className="hero-chip">{auth.organizationName}</span>
            <span className={cx("pill", "pill--warning")}>{formatTokenLabel(auth.role)}</span>
          </div>
          <p className="hero-note">
            {payload?.count ?? 0} total error claims in the organization workspace.
          </p>
          <div className="hero-actions">
            <Link href="/dashboard" className="button button--secondary">
              Return to dashboard
            </Link>
          </div>
        </div>
      </section>

      <section className="summary-strip">
        <article className="stat-card">
          <p className="stat-label">Error queue</p>
          <strong className="stat-value">{payload?.count ?? 0}</strong>
          <p className="stat-note">Total claims currently marked with an error status.</p>
        </article>
        <article className="stat-card">
          <p className="stat-label">Retryable on page</p>
          <strong className="stat-value">{retryableCount}</strong>
          <p className="stat-note">
            Visible failures that may be recoverable without manual edits.
          </p>
        </article>
        <article className="stat-card">
          <p className="stat-label">Page limit</p>
          <strong className="stat-value">{filters.limit}</strong>
          <p className="stat-note">Current fetch size for triage paging and review workflow.</p>
        </article>
      </section>

      <section className="insight-grid">
        <article className="surface-card panel section-stack">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Retryability mix</p>
              <h2 className="section-title">Current page breakdown</h2>
              <p className="section-copy">
                This page groups visible error claims by whether they appear retryable, blocked, or
                still ambiguous.
              </p>
            </div>
          </div>

          <div className="workflow-list">
            {retryabilityBreakdown.map((entry) => (
              <div className="workflow-row" key={entry.label}>
                <div className="workflow-heading">
                  <div className="cluster">
                    <span className={cx("pill", `pill--${entry.tone}`)}>{entry.label}</span>
                    <p className="workflow-meta">
                      {entry.count} claim{entry.count === 1 ? "" : "s"}
                    </p>
                  </div>
                  <span className="workflow-percent">{formatPercent(entry.percent)}</span>
                </div>
                <div className="workflow-track" aria-hidden="true">
                  <div
                    className={cx("workflow-fill", `workflow-fill--${entry.tone}`)}
                    style={{ width: `${entry.count > 0 ? Math.max(entry.percent, 4) : 0}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="surface-card panel section-stack">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Triage notes</p>
              <h2 className="section-title">Exception pressure</h2>
              <p className="section-copy">
                Page-level signals to help prioritize which failures should get first attention.
              </p>
            </div>
          </div>

          <div className="glance-grid">
            <article className="glance-card glance-card--success">
              <p className="glance-label">Retryable share</p>
              <h3 className="glance-value">
                {formatPercent(toPercent(retryableCount, pageClaims.length))}
              </h3>
              <p className="glance-copy">
                Start here if you want the fastest path to clearing the visible error queue.
              </p>
            </article>

            <article className="glance-card glance-card--danger">
              <p className="glance-label">Hard failures</p>
              <h3 className="glance-value">{nonRetryableCount}</h3>
              <p className="glance-copy">
                Claims on this page that likely need investigation or manual correction.
              </p>
            </article>

            <article className="glance-card glance-card--neutral">
              <p className="glance-label">Unknown retryability</p>
              <h3 className="glance-value">{unknownRetryabilityCount}</h3>
              <p className="glance-copy">
                Failures without enough context yet to classify as recoverable or blocked.
              </p>
            </article>

            <article className="glance-card glance-card--warning">
              <p className="glance-label">Highest receive count</p>
              <h3 className="glance-value">{highestReceiveCount}</h3>
              <p className="glance-copy">
                The most repeated receive count among the visible failures, useful for spotting
                noisy retries.
              </p>
            </article>
          </div>
        </article>
      </section>

      <section className="surface-card panel section-stack">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Refine results</p>
            <h2 className="section-title">Failure search</h2>
            <p className="section-copy">
              Filter by claim metadata or creation window to isolate the group of failed claims you
              need to inspect.
            </p>
          </div>
        </div>

        <form method="get" className="section-stack">
          <div className="error-filter-grid">
            <label className="field-label">
              <span>Search</span>
              <input
                className="control"
                type="text"
                name="search"
                defaultValue={filters.search ?? ""}
                placeholder="Claim ID, customer, product, source email..."
              />
            </label>

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

            <label className="field-label">
              <span>Limit</span>
              <input
                className="control"
                type="number"
                min={1}
                max={200}
                name="limit"
                defaultValue={filters.limit}
              />
            </label>
          </div>

          <div className="cluster">
            <button type="submit" className="button button--primary">
              Refresh
            </button>
            <Link href="/dashboard/errors" className="button button--secondary">
              Clear
            </Link>
          </div>
        </form>
      </section>

      {loadError ? <p className="notice notice--danger">{loadError}</p> : null}

      <section className="surface-card table-card">
        <div className="table-toolbar">
          <div>
            <p className="section-kicker">Failure queue</p>
            <h2 className="section-title">Claims in error</h2>
            <p className="section-copy">
              Each row shows the latest failure metadata alongside a direct link back to the claim.
            </p>
          </div>
        </div>

        <div className="table-scroll">
          <table className="data-table data-table--responsive">
            <thead>
              <tr>
                <th>Claim</th>
                <th>Customer / Product</th>
                <th>Updated</th>
                <th>Failure Reason</th>
                <th>Retryable</th>
                <th>Receive Count</th>
                <th>Disposition</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {!payload || payload.claims.length === 0 ? (
                <tr>
                  <td colSpan={8} className="empty-state">
                    No error claims found for the selected filters.
                  </td>
                </tr>
              ) : (
                payload.claims.map((claim) => (
                  <tr key={claim.id}>
                    <td data-label="Claim">
                      <div className="cluster">
                        <span className={cx("pill", `pill--${getClaimStatusTone(claim.status)}`)}>
                          {formatTokenLabel(claim.status)}
                        </span>
                      </div>
                      <span className="subtle-text">
                        {claim.externalClaimId ?? claim.id.slice(0, 12)}
                      </span>
                    </td>
                    <td data-label="Customer / Product">
                      <div>{claim.customerName ?? "-"}</div>
                      <span className="subtle-text">{claim.productName ?? "-"}</span>
                    </td>
                    <td data-label="Updated">
                      <div>{formatUtcDateTime(claim.updatedAt)}</div>
                      <span className="subtle-text">{claim.sourceEmail ?? "-"}</span>
                    </td>
                    <td data-label="Failure Reason">
                      <div>{claim.failure?.reason ?? "-"}</div>
                      <span className="subtle-text">
                        {claim.failure?.fromStatus ?? "?"} to {claim.failure?.toStatus ?? "?"}
                      </span>
                    </td>
                    <td data-label="Retryable">
                      <span
                        className={cx("pill", `pill--${getBooleanTone(claim.failure?.retryable)}`)}
                      >
                        {claim.failure?.retryable == null
                          ? "Unknown"
                          : claim.failure.retryable
                            ? "Yes"
                            : "No"}
                      </span>
                    </td>
                    <td data-label="Receive Count">{claim.failure?.receiveCount ?? "-"}</td>
                    <td data-label="Disposition">
                      {claim.failure?.failureDisposition ? (
                        <span className="subtle-text">
                          {formatTokenLabel(claim.failure.failureDisposition)}
                        </span>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td data-label="Actions">
                      <Link href={`/dashboard/claims/${claim.id}`} className="table-link">
                        Open claim
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {payload?.nextCursor || payload?.prevCursor ? (
        <div className="pagination-row">
          {payload.prevCursor ? (
            <Link
              href={buildErrorClaimsHref(filters, payload.prevCursor, "prev")}
              className="button button--secondary"
            >
              Previous page
            </Link>
          ) : null}
          {payload.nextCursor ? (
            <Link
              href={buildErrorClaimsHref(filters, payload.nextCursor, "next")}
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

function buildErrorClaimsHref(
  filters: {
    search: string | null;
    createdFrom: Date | null;
    createdTo: Date | null;
    limit: number;
  },
  cursor: string,
  direction: ErrorClaimsPageDirection,
): string {
  const params = serializeFiltersToQueryParams({
    status: null,
    search: filters.search,
    createdFrom: filters.createdFrom,
    createdTo: filters.createdTo,
  });
  params.set("limit", String(filters.limit));
  params.set("cursor", cursor);
  params.set("direction", direction);
  return `/dashboard/errors?${params.toString()}`;
}

function toPercent(count: number, total: number): number {
  if (total === 0) {
    return 0;
  }

  return Math.round((count / total) * 100);
}

function formatPercent(value: number): string {
  return `${value}%`;
}
