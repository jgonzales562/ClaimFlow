import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDashboardPage } from "../apps/web/app/dashboard/dashboard-page.tsx";

const BASE_AUTH = {
  userId: "user-dashboard-page",
  organizationId: "org-dashboard-page",
  organizationName: "Dashboard Test Org",
  email: "dashboard@example.com",
};

const EMPTY_CLAIM_WINDOW = {
  claims: [],
  nextCursor: null,
  prevCursor: null,
};

const PAGE_SUMMARY = {
  totalClaims: 18,
  statusCounts: {
    NEW: 4,
    PROCESSING: 3,
    REVIEW_REQUIRED: 5,
    READY: 4,
    ERROR: 2,
  },
  staleProcessingCount: 1,
  operationalActivity: {
    windowHours: 24,
    watchdogRecoveryCount: 2,
    manualProcessingRecoveryCount: 1,
    manualRetryCount: 3,
  },
};

const OPERATIONAL_SUMMARY = {
  ...PAGE_SUMMARY,
  ingestQueueOutbox: {
    pendingCount: 5,
    dueCount: 2,
    oldestPendingAgeMinutes: 26,
    oldestPendingCreatedAt: new Date("2026-03-30T11:34:00.000Z"),
    oldestDueAgeMinutes: 11,
    oldestDueAvailableAt: new Date("2026-03-30T11:49:00.000Z"),
  },
};

test("dashboard page renders the outbox posture panel for admins", async () => {
  let pageSummaryCalls = 0;
  let operationalSummaryCalls = 0;

  const DashboardPage = createDashboardPage({
    getAuthContextFn: async () => ({
      ...BASE_AUTH,
      role: "ADMIN" as const,
    }),
    LinkComponent: TestLink,
    hasMinimumRoleFn: (currentRole, requiredRole) =>
      rankRole(currentRole) >= rankRole(requiredRole),
    listDashboardClaimWindowFn: async () => EMPTY_CLAIM_WINDOW,
    loadCachedDashboardPageSummaryFn: async () => {
      pageSummaryCalls += 1;
      return PAGE_SUMMARY;
    },
    loadCachedDashboardOperationalSummaryFn: async () => {
      operationalSummaryCalls += 1;
      return OPERATIONAL_SUMMARY;
    },
  });

  const html = renderToStaticMarkup(
    await DashboardPage({
      searchParams: Promise.resolve({}),
    }),
  );

  assert.match(html, /Queue outbox posture/);
  assert.match(html, /Dispatch backlog/);
  assert.match(html, /Due now/);
  assert.match(html, /Pending total/);
  assert.match(html, /11 min/);
  assert.match(html, /26 min/);
  assert.equal(pageSummaryCalls, 0);
  assert.equal(operationalSummaryCalls, 1);
});

test("dashboard page hides the outbox posture panel for non-admin roles", async () => {
  let pageSummaryCalls = 0;
  let operationalSummaryCalls = 0;

  const DashboardPage = createDashboardPage({
    getAuthContextFn: async () => ({
      ...BASE_AUTH,
      role: "ANALYST" as const,
    }),
    LinkComponent: TestLink,
    hasMinimumRoleFn: (currentRole, requiredRole) =>
      rankRole(currentRole) >= rankRole(requiredRole),
    listDashboardClaimWindowFn: async () => EMPTY_CLAIM_WINDOW,
    loadCachedDashboardPageSummaryFn: async () => {
      pageSummaryCalls += 1;
      return PAGE_SUMMARY;
    },
    loadCachedDashboardOperationalSummaryFn: async () => {
      operationalSummaryCalls += 1;
      return OPERATIONAL_SUMMARY;
    },
  });

  const html = renderToStaticMarkup(
    await DashboardPage({
      searchParams: Promise.resolve({}),
    }),
  );

  assert.doesNotMatch(html, /Queue outbox posture/);
  assert.doesNotMatch(html, /Dispatch backlog/);
  assert.equal(pageSummaryCalls, 1);
  assert.equal(operationalSummaryCalls, 0);
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

function TestLink({
  href,
  children,
  ...props
}: {
  href: string;
  children: React.ReactNode;
  [key: string]: unknown;
}) {
  return React.createElement("a", {
    ...props,
    href,
    children,
  });
}
