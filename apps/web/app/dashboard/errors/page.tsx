import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import { getAuthContext, hasMinimumRole } from "@/lib/auth/server";

type ErrorClaimsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type ErrorClaimsResponse = {
  claims: ErrorClaimRecord[];
  count: number;
};

type ErrorClaimRecord = {
  id: string;
  externalClaimId: string | null;
  sourceEmail: string | null;
  customerName: string | null;
  productName: string | null;
  status: string;
  warrantyStatus: string;
  createdAt: string;
  updatedAt: string;
  failure: {
    source: "worker_failure";
    occurredAt: string;
    reason: string | null;
    retryable: boolean | null;
    receiveCount: number | null;
    failureDisposition: string | null;
    fromStatus: string | null;
    toStatus: string | null;
  } | null;
};

export default async function ErrorClaimsPage({ searchParams }: ErrorClaimsPageProps) {
  const auth = await getAuthContext();
  if (!auth) {
    redirect("/login");
  }

  if (!hasMinimumRole(auth.role, "ADMIN")) {
    redirect("/dashboard?error=forbidden");
  }

  const resolvedSearchParams = (await searchParams) ?? {};
  const filters = {
    search: readSearchParam(resolvedSearchParams, "search"),
    createdFrom: readSearchParam(resolvedSearchParams, "created_from"),
    createdTo: readSearchParam(resolvedSearchParams, "created_to"),
    limit: clampLimit(readSearchParam(resolvedSearchParams, "limit"), 50, 1, 200),
  };

  const apiQuery = new URLSearchParams();
  if (filters.search) {
    apiQuery.set("search", filters.search);
  }
  if (filters.createdFrom) {
    apiQuery.set("created_from", filters.createdFrom);
  }
  if (filters.createdTo) {
    apiQuery.set("created_to", filters.createdTo);
  }
  apiQuery.set("limit", String(filters.limit));

  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host") ?? "localhost:3000";
  const proto =
    headerStore.get("x-forwarded-proto") ??
    (host.includes("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  const cookieHeader = headerStore.get("cookie") ?? "";
  const endpoint = `${proto}://${host}/api/claims/errors?${apiQuery.toString()}`;

  let payload: ErrorClaimsResponse | null = null;
  let loadError: string | null = null;

  try {
    const response = await fetch(endpoint, {
      headers: {
        cookie: cookieHeader,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      loadError =
        response.status === 403
          ? "You do not have permission to view error triage."
          : "Unable to load error claims.";
    } else {
      payload = (await response.json()) as ErrorClaimsResponse;
    }
  } catch {
    loadError = "Unable to load error claims.";
  }

  return (
    <main style={{ maxWidth: 1180, margin: "48px auto", padding: "0 24px 40px" }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <p style={{ margin: "0 0 6px" }}>
            <Link href="/dashboard" style={inlineLinkStyle}>
              Back to Dashboard
            </Link>
          </p>
          <h1 style={{ margin: 0 }}>Error Claim Triage</h1>
          <p style={{ margin: "8px 0 0", color: "#495366" }}>
            {auth.organizationName} ({auth.role}) - {payload?.count ?? 0} error claims
          </p>
        </div>
      </header>

      <section style={filterCardStyle}>
        <form method="get" style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 120px", gap: 10 }}>
            <label style={fieldLabelStyle}>
              <span>Search</span>
              <input
                type="text"
                name="search"
                defaultValue={filters.search ?? ""}
                placeholder="Claim ID, customer, product, source email..."
                style={inputStyle}
              />
            </label>

            <label style={fieldLabelStyle}>
              <span>Created From</span>
              <input
                type="date"
                name="created_from"
                defaultValue={filters.createdFrom ?? ""}
                style={inputStyle}
              />
            </label>

            <label style={fieldLabelStyle}>
              <span>Created To</span>
              <input
                type="date"
                name="created_to"
                defaultValue={filters.createdTo ?? ""}
                style={inputStyle}
              />
            </label>

            <label style={fieldLabelStyle}>
              <span>Limit</span>
              <input
                type="number"
                min={1}
                max={200}
                name="limit"
                defaultValue={filters.limit}
                style={inputStyle}
              />
            </label>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" style={primaryButtonStyle}>
              Refresh
            </button>
            <Link href="/dashboard/errors" style={secondaryLinkButtonStyle}>
              Clear
            </Link>
          </div>
        </form>
      </section>

      {loadError ? <p style={errorStyle}>{loadError}</p> : null}

      <section style={tableCardStyle}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead style={{ textAlign: "left", background: "#f9fafb" }}>
            <tr>
              <th style={thStyle}>Claim</th>
              <th style={thStyle}>Customer / Product</th>
              <th style={thStyle}>Updated</th>
              <th style={thStyle}>Failure Reason</th>
              <th style={thStyle}>Retryable</th>
              <th style={thStyle}>Receive Count</th>
              <th style={thStyle}>Disposition</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {!payload || payload.claims.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ padding: 16, color: "#667084" }}>
                  No error claims found for the selected filters.
                </td>
              </tr>
            ) : (
              payload.claims.map((claim) => (
                <tr key={claim.id} style={{ borderTop: "1px solid #eef2f6" }}>
                  <td style={tdStyle}>
                    <div>{claim.externalClaimId ?? claim.id.slice(0, 12)}</div>
                    <div style={subtleTextStyle}>{claim.status}</div>
                  </td>
                  <td style={tdStyle}>
                    <div>{claim.customerName ?? "-"}</div>
                    <div style={subtleTextStyle}>{claim.productName ?? "-"}</div>
                  </td>
                  <td style={tdStyle}>
                    <div>{formatDateTime(claim.updatedAt)}</div>
                    <div style={subtleTextStyle}>{claim.sourceEmail ?? "-"}</div>
                  </td>
                  <td style={tdStyle}>
                    {claim.failure?.reason ?? "-"}
                    <div style={subtleTextStyle}>
                      {claim.failure?.fromStatus ?? "?"} -&gt; {claim.failure?.toStatus ?? "?"}
                    </div>
                  </td>
                  <td style={tdStyle}>
                    {claim.failure?.retryable == null
                      ? "-"
                      : claim.failure.retryable
                        ? "Yes"
                        : "No"}
                  </td>
                  <td style={tdStyle}>{claim.failure?.receiveCount ?? "-"}</td>
                  <td style={tdStyle}>{claim.failure?.failureDisposition ?? "-"}</td>
                  <td style={tdStyle}>
                    <Link href={`/dashboard/claims/${claim.id}`} style={inlineLinkStyle}>
                      Open Claim
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function readSearchParam(
  searchParams: Record<string, string | string[] | undefined>,
  key: string,
): string | null {
  const value = searchParams[key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
    const trimmed = value[0].trim();
    return trimmed ? trimmed : null;
  }

  return null;
}

function clampLimit(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toISOString().replace("T", " ").slice(0, 19);
}

const filterCardStyle: CSSProperties = {
  border: "1px solid #e4e7ec",
  borderRadius: 10,
  background: "#fff",
  padding: 14,
  marginBottom: 14,
};

const tableCardStyle: CSSProperties = {
  border: "1px solid #e4e7ec",
  borderRadius: 10,
  background: "#fff",
  overflow: "hidden",
};

const fieldLabelStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  fontSize: 13,
  color: "#344054",
};

const inputStyle: CSSProperties = {
  border: "1px solid #d0d5dd",
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 14,
};

const primaryButtonStyle: CSSProperties = {
  border: "1px solid #0f172a",
  borderRadius: 8,
  background: "#0f172a",
  color: "#fff",
  padding: "8px 12px",
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryLinkButtonStyle: CSSProperties = {
  border: "1px solid #d0d5dd",
  borderRadius: 8,
  background: "#fff",
  color: "#1d2939",
  padding: "8px 12px",
  textDecoration: "none",
  display: "inline-flex",
  alignItems: "center",
};

const inlineLinkStyle: CSSProperties = {
  color: "#155eef",
  textDecoration: "none",
};

const thStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid #eaecf0",
  fontWeight: 600,
  color: "#344054",
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  color: "#1d2939",
  verticalAlign: "top",
};

const subtleTextStyle: CSSProperties = {
  marginTop: 4,
  color: "#667084",
  fontSize: 12,
};

const errorStyle: CSSProperties = {
  background: "#fff1f2",
  color: "#991b1b",
  border: "1px solid #fecdd3",
  borderRadius: 8,
  padding: 12,
  marginBottom: 12,
};
