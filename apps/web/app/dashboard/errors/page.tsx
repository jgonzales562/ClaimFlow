import Link from "next/link";
import { redirect } from "next/navigation";
import {
  GlanceCard,
  NoticeBanner,
  PageHero,
  PanelSection,
  Pill,
  StatCard,
  TableSection,
  WorkflowMeter,
} from "@/components/ui/dashboard";
import { getCachedAuthContext, hasMinimumRole } from "@/lib/auth/server";
import {
  clampLimit,
  formatDateInput,
  parseClaimFiltersFromRecord,
  readSearchParam,
} from "@/lib/claims/filters";
import { buildClaimCursorHref } from "@/lib/claims/query-links";
import { formatUtcDateTime } from "@/lib/format";
import {
  listErrorClaims,
  parseErrorClaimsCursor,
  parseErrorClaimsPageDirection,
} from "@/lib/claims/error-claims";
import {
  formatClaimReference,
  formatPercent,
  formatTokenLabel,
  getBooleanTone,
  getClaimStatusTone,
  toPercent,
} from "@/lib/ui";

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
      tone: "success" as const,
    },
    {
      label: "Non-retryable",
      count: nonRetryableCount,
      percent: toPercent(nonRetryableCount, pageClaims.length),
      tone: "danger" as const,
    },
    {
      label: "Unknown",
      count: unknownRetryabilityCount,
      percent: toPercent(unknownRetryabilityCount, pageClaims.length),
      tone: "neutral" as const,
    },
  ];

  return (
    <main className="app-shell app-shell--wide page-stack">
      <PageHero
        eyebrow="Exception handling"
        title="Error Claim Triage"
        subtitle="Review failed claims, inspect the failure reason, and move anything retryable back into the queue with context."
        breadcrumbHref="/dashboard"
        breadcrumbLabel="Back to dashboard"
        meta={
          <>
            <span className="hero-chip">{auth.organizationName}</span>
            <Pill tone="warning">{formatTokenLabel(auth.role)}</Pill>
          </>
        }
        note={`${payload?.totalCount ?? 0} total error claims in the organization workspace.`}
        actions={
          <Link href="/dashboard" className="button button--secondary">
            Return to dashboard
          </Link>
        }
      />

      <section className="summary-strip">
        <StatCard
          label="Error queue"
          value={payload?.totalCount ?? 0}
          note="Total claims currently marked with an error status."
        />
        <StatCard
          label="Retryable on page"
          value={retryableCount}
          note="Visible failures that may be recoverable without manual edits."
        />
        <StatCard
          label="Page limit"
          value={filters.limit}
          note="Current fetch size for triage paging and review workflow."
        />
      </section>

      <section className="insight-grid">
        <PanelSection
          kicker="Retryability mix"
          title="Current page breakdown"
          copy="This page groups visible error claims by whether they appear retryable, blocked, or still ambiguous."
        >
          <div className="workflow-list">
            {retryabilityBreakdown.map((entry) => (
              <WorkflowMeter
                key={entry.label}
                label={entry.label}
                meta={`${entry.count} claim${entry.count === 1 ? "" : "s"}`}
                percent={entry.percent}
                tone={entry.tone}
              />
            ))}
          </div>
        </PanelSection>

        <PanelSection
          kicker="Triage notes"
          title="Exception pressure"
          copy="Page-level signals to help prioritize which failures should get first attention."
        >
          <div className="glance-grid">
            <GlanceCard
              tone="success"
              label="Retryable share"
              value={formatPercent(toPercent(retryableCount, pageClaims.length))}
              copy="Start here if you want the fastest path to clearing the visible error queue."
            />
            <GlanceCard
              tone="danger"
              label="Hard failures"
              value={nonRetryableCount}
              copy="Claims on this page that likely need investigation or manual correction."
            />
            <GlanceCard
              tone="neutral"
              label="Unknown retryability"
              value={unknownRetryabilityCount}
              copy="Failures without enough context yet to classify as recoverable or blocked."
            />
            <GlanceCard
              tone="warning"
              label="Highest receive count"
              value={highestReceiveCount}
              copy="The most repeated receive count among the visible failures, useful for spotting noisy retries."
            />
          </div>
        </PanelSection>
      </section>

      <PanelSection
        kicker="Refine results"
        title="Failure search"
        copy="Filter by claim metadata or creation window to isolate the group of failed claims you need to inspect."
      >
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
      </PanelSection>

      {loadError ? <NoticeBanner tone="danger">{loadError}</NoticeBanner> : null}

      <TableSection
        kicker="Failure queue"
        title="Claims in error"
        copy="Each row shows the latest failure metadata alongside a direct link back to the claim."
      >
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
                        <Pill tone={getClaimStatusTone(claim.status)}>
                          {formatTokenLabel(claim.status)}
                        </Pill>
                      </div>
                      <span className="subtle-text">
                        {formatClaimReference(claim.externalClaimId, claim.id)}
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
                      <Pill tone={getBooleanTone(claim.failure?.retryable)}>
                        {claim.failure?.retryable == null
                          ? "Unknown"
                          : claim.failure.retryable
                            ? "Yes"
                            : "No"}
                      </Pill>
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
      </TableSection>

      {payload?.nextCursor || payload?.prevCursor ? (
        <div className="pagination-row">
          {payload.prevCursor ? (
            <Link
              href={buildClaimCursorHref(
                "/dashboard/errors",
                {
                  status: null,
                  search: filters.search,
                  createdFrom: filters.createdFrom,
                  createdTo: filters.createdTo,
                },
                payload.prevCursor,
                "prev",
                { limit: filters.limit },
              )}
              className="button button--secondary"
            >
              Previous page
            </Link>
          ) : null}
          {payload.nextCursor ? (
            <Link
              href={buildClaimCursorHref(
                "/dashboard/errors",
                {
                  status: null,
                  search: filters.search,
                  createdFrom: filters.createdFrom,
                  createdTo: filters.createdTo,
                },
                payload.nextCursor,
                "next",
                { limit: filters.limit },
              )}
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
