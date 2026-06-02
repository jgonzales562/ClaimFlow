import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createExtractionSettingsPage } from "../apps/web/app/dashboard/settings/extraction/extraction-settings-page.tsx";

test("extraction settings page renders configured organization keywords for admins", async () => {
  const ExtractionSettingsPage = createExtractionSettingsPage({
    getAuthContextFn: async () => ({
      userId: "settings-user",
      email: "settings@example.com",
      organizationId: "settings-org",
      organizationName: "Settings Org",
      role: "ADMIN",
    }),
    hasMinimumRoleFn: (currentRole, requiredRole) =>
      rankRole(currentRole) >= rankRole(requiredRole),
    loadOrganizationExtractionSettingsFn: async () => ({
      organizationId: "settings-org",
      scanKeywords: ["compressor failure", "proof of purchase"],
      updatedAt: new Date("2026-04-28T16:30:00.000Z"),
    }),
    updateExtractionSettingsActionFn: async () => {},
  });

  const html = renderToStaticMarkup(
    await ExtractionSettingsPage({
      searchParams: Promise.resolve({
        notice: "settings_updated",
      }),
    }),
  );

  assert.match(html, /Company Scan Keywords/);
  assert.match(html, /Settings Org/);
  assert.match(html, /compressor failure/);
  assert.match(html, /proof of purchase/);
  assert.match(html, /Extraction scan keywords saved/);
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
