import { prisma } from "@claimflow/db";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import { getAuthContext } from "@/lib/auth/server";
import {
  buildClaimWhereInput,
  CLAIM_STATUSES,
  formatDateInput,
  parseClaimFiltersFromRecord,
  serializeFiltersToQueryParams,
} from "@/lib/claims/filters";

type DashboardPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const auth = await getAuthContext();
  if (!auth) {
    redirect("/login");
  }

  const resolvedSearchParams = (await searchParams) ?? {};
  const filters = parseClaimFiltersFromRecord(resolvedSearchParams);

  const claims = await prisma.claim.findMany({
    where: buildClaimWhereInput(auth.organizationId, filters),
    orderBy: {
      createdAt: "desc",
    },
    take: 100,
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
  });

  const exportQueryParams = serializeFiltersToQueryParams(filters);
  exportQueryParams.set("limit", "1000");
  const csvExportHref = `/api/claims/export?${buildExportQuery(exportQueryParams, "csv")}`;
  const jsonExportHref = `/api/claims/export?${buildExportQuery(exportQueryParams, "json")}`;

  return (
    <main style={{ maxWidth: 1080, margin: "56px auto", padding: "0 24px" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 18,
        }}
      >
        <div>
          <h1 style={{ marginBottom: 8 }}>ClaimFlow Dashboard</h1>
          <p style={{ margin: 0, color: "#495366" }}>
            {auth.organizationName} ({auth.role}) - signed in as {auth.email}
          </p>
        </div>
        <form action="/api/auth/logout" method="post">
          <button type="submit" style={secondaryButtonStyle}>
            Sign out
          </button>
        </form>
      </header>

      <section
        style={{
          border: "1px solid #e4e7ec",
          borderRadius: 10,
          padding: 14,
          background: "#fff",
          marginBottom: 14,
        }}
      >
        <form method="get" style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
            <label style={fieldLabelStyle}>
              <span>Search</span>
              <input
                type="text"
                name="search"
                defaultValue={filters.search ?? ""}
                placeholder="Claim ID, customer, product, issue..."
                style={inputStyle}
              />
            </label>

            <label style={fieldLabelStyle}>
              <span>Status</span>
              <select name="status" defaultValue={filters.status ?? ""} style={inputStyle}>
                <option value="">All statuses</option>
                {CLAIM_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto auto", gap: 10 }}>
            <label style={fieldLabelStyle}>
              <span>Created From</span>
              <input
                type="date"
                name="created_from"
                defaultValue={formatDateInput(filters.createdFrom)}
                style={inputStyle}
              />
            </label>

            <label style={fieldLabelStyle}>
              <span>Created To</span>
              <input
                type="date"
                name="created_to"
                defaultValue={formatDateInput(filters.createdTo)}
                style={inputStyle}
              />
            </label>

            <div style={{ display: "flex", alignItems: "end", gap: 8 }}>
              <button type="submit" style={primaryButtonStyle}>
                Apply Filters
              </button>
              <Link href="/dashboard" style={linkButtonStyle}>
                Clear
              </Link>
            </div>

            <div style={{ display: "flex", alignItems: "end", gap: 8 }}>
              <a href={csvExportHref} style={linkButtonStyle}>
                Export CSV
              </a>
              <a href={jsonExportHref} style={linkButtonStyle}>
                Export JSON
              </a>
            </div>
          </div>
        </form>
      </section>

      <section
        style={{
          border: "1px solid #e4e7ec",
          borderRadius: 10,
          overflow: "hidden",
          background: "#fff",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead style={{ background: "#f9fafb", textAlign: "left" }}>
            <tr>
              <th style={thStyle}>Claim ID</th>
              <th style={thStyle}>Customer</th>
              <th style={thStyle}>Product</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Warranty</th>
              <th style={thStyle}>Created</th>
              <th style={thStyle}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {claims.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ padding: 16, color: "#667084" }}>
                  No claims found for the selected filters.
                </td>
              </tr>
            ) : (
              claims.map((claim) => (
                <tr key={claim.id} style={{ borderTop: "1px solid #f2f4f7" }}>
                  <td style={tdStyle}>
                    <Link href={`/dashboard/claims/${claim.id}`} style={claimLinkStyle}>
                      {claim.externalClaimId ?? claim.id.slice(0, 10)}
                    </Link>
                  </td>
                  <td style={tdStyle}>{claim.customerName ?? "-"}</td>
                  <td style={tdStyle}>{claim.productName ?? "-"}</td>
                  <td style={tdStyle}>{claim.status}</td>
                  <td style={tdStyle}>{claim.warrantyStatus}</td>
                  <td style={tdStyle}>{claim.createdAt.toISOString().slice(0, 10)}</td>
                  <td style={tdStyle}>{claim.updatedAt.toISOString().slice(0, 10)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function buildExportQuery(baseParams: URLSearchParams, format: "csv" | "json"): string {
  const copy = new URLSearchParams(baseParams);
  copy.set("format", format);
  return copy.toString();
}

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

const thStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid #eaecf0",
  fontWeight: 600,
  color: "#344054",
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  color: "#1d2939",
};

const primaryButtonStyle: CSSProperties = {
  border: "1px solid #0f172a",
  borderRadius: 8,
  background: "#0f172a",
  color: "#fff",
  padding: "8px 12px",
  fontWeight: 600,
  cursor: "pointer",
  textDecoration: "none",
};

const secondaryButtonStyle: CSSProperties = {
  border: "1px solid #d0d5dd",
  borderRadius: 8,
  background: "#fff",
  padding: "8px 12px",
  cursor: "pointer",
};

const linkButtonStyle: CSSProperties = {
  ...secondaryButtonStyle,
  textDecoration: "none",
  color: "#1d2939",
  display: "inline-flex",
  alignItems: "center",
};

const claimLinkStyle: CSSProperties = {
  color: "#155eef",
  textDecoration: "none",
  fontWeight: 600,
};
