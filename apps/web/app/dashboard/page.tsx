import { prisma } from "@claimflow/db";
import { redirect } from "next/navigation";
import type { CSSProperties } from "react";
import { getAuthContext } from "@/lib/auth/server";

export default async function DashboardPage() {
  const auth = await getAuthContext();
  if (!auth) {
    redirect("/login");
  }

  const claims = await prisma.claim.findMany({
    where: {
      organizationId: auth.organizationId,
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 50,
    select: {
      id: true,
      externalClaimId: true,
      customerName: true,
      productName: true,
      status: true,
      warrantyStatus: true,
      createdAt: true,
    },
  });

  return (
    <main style={{ maxWidth: 980, margin: "56px auto", padding: "0 24px" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 24,
        }}
      >
        <div>
          <h1 style={{ marginBottom: 8 }}>ClaimFlow Dashboard</h1>
          <p style={{ margin: 0, color: "#495366" }}>
            {auth.organizationName} ({auth.role}) - signed in as {auth.email}
          </p>
        </div>
        <form action="/api/auth/logout" method="post">
          <button type="submit" style={logoutButtonStyle}>
            Sign out
          </button>
        </form>
      </header>

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
            </tr>
          </thead>
          <tbody>
            {claims.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: 16, color: "#667084" }}>
                  No claims found for this organization.
                </td>
              </tr>
            ) : (
              claims.map((claim) => (
                <tr key={claim.id} style={{ borderTop: "1px solid #f2f4f7" }}>
                  <td style={tdStyle}>{claim.externalClaimId ?? claim.id.slice(0, 10)}</td>
                  <td style={tdStyle}>{claim.customerName ?? "-"}</td>
                  <td style={tdStyle}>{claim.productName ?? "-"}</td>
                  <td style={tdStyle}>{claim.status}</td>
                  <td style={tdStyle}>{claim.warrantyStatus}</td>
                  <td style={tdStyle}>{claim.createdAt.toISOString().slice(0, 10)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}

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

const logoutButtonStyle: CSSProperties = {
  border: "1px solid #d0d5dd",
  borderRadius: 8,
  background: "#fff",
  padding: "8px 12px",
  cursor: "pointer",
};
