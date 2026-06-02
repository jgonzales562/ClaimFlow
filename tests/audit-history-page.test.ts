import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createAuditHistoryPage } from "../apps/web/app/dashboard/audit/audit-history-page.tsx";

test("audit history page renders organization export and access events for admins", async () => {
  const AuditHistoryPage = createAuditHistoryPage({
    getAuthContextFn: async () => ({
      userId: "audit-user",
      email: "audit@example.com",
      organizationId: "audit-org",
      organizationName: "Audit Org",
      role: "ADMIN",
    }),
    hasMinimumRoleFn: (currentRole, requiredRole) =>
      rankRole(currentRole) >= rankRole(requiredRole),
    listOrganizationAuditEventsFn: async () => [
      {
        id: "audit-1",
        eventType: "CLAIM_EXPORT",
        payload: {
          format: "csv",
          limit: 100,
        },
        createdAt: new Date("2026-04-28T16:30:00.000Z"),
        actorUser: {
          email: "admin@example.com",
          fullName: "Admin User",
        },
      },
      {
        id: "audit-2",
        eventType: "ATTACHMENT_ACCESS",
        payload: {
          disposition: "download",
          originalFilename: "receipt.pdf",
        },
        createdAt: new Date("2026-04-28T16:00:00.000Z"),
        actorUser: null,
      },
    ],
  });

  const html = renderToStaticMarkup(await AuditHistoryPage());

  assert.match(html, /Export and Access History/);
  assert.match(html, /Audit Org/);
  assert.match(html, /Claim Export/);
  assert.match(html, /Claim export requested as csv with limit 100/);
  assert.match(html, /Attachment Access/);
  assert.match(html, /Attachment download requested for receipt.pdf/);
});

function rankRole(role: "OWNER" | "ADMIN" | "ANALYST" | "VIEWER"): number {
  if (role === "OWNER") {
    return 4;
  }
  if (role === "ADMIN") {
    return 3;
  }
  if (role === "ANALYST") {
    return 2;
  }
  return 1;
}
