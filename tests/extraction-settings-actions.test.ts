import assert from "node:assert/strict";
import { test } from "node:test";
import { createExtractionSettingsActionHandlers } from "../apps/web/lib/extraction/settings-actions.ts";

class RedirectSignal extends Error {
  readonly location: string;

  constructor(location: string) {
    super(`Redirect: ${location}`);
    this.location = location;
  }
}

const DEFAULT_AUTH = {
  userId: "settings-user",
  organizationId: "settings-org",
  role: "ADMIN" as const,
};

test("extraction settings action rejects failed same-origin checks", async () => {
  const harness = createHarness({
    assertSameOriginFn: async () => false,
  });

  await expectRedirect(
    () => harness.handlers.updateExtractionSettingsAction(buildFormData()),
    "/dashboard/settings/extraction?error=invalid_request",
  );

  assert.equal(harness.updateCalls.length, 0);
});

test("extraction settings action requires admin access", async () => {
  const harness = createHarness({
    getAuthContextFn: async () => ({ ...DEFAULT_AUTH, role: "ANALYST" as const }),
  });

  await expectRedirect(
    () => harness.handlers.updateExtractionSettingsAction(buildFormData()),
    "/dashboard?error=forbidden",
  );

  assert.equal(harness.updateCalls.length, 0);
});

test("extraction settings action redirects unauthenticated users to login", async () => {
  const harness = createHarness({
    getAuthContextFn: async () => null,
  });

  await expectRedirect(
    () => harness.handlers.updateExtractionSettingsAction(buildFormData()),
    "/login?redirect=%2Fdashboard%2Fsettings%2Fextraction",
  );

  assert.equal(harness.updateCalls.length, 0);
});

test("extraction settings action saves keywords and revalidates settings paths", async () => {
  const harness = createHarness({
    updateOrganizationExtractionSettingsFn: async (input) => {
      harness.updateCalls.push(input);
      return {
        kind: "updated",
        scanKeywords: ["compressor failure", "proof of purchase"],
      };
    },
  });

  await expectRedirect(
    () => harness.handlers.updateExtractionSettingsAction(buildFormData()),
    "/dashboard/settings/extraction?notice=settings_updated",
  );

  assert.deepEqual(harness.updateCalls, [
    {
      organizationId: DEFAULT_AUTH.organizationId,
      actorUserId: DEFAULT_AUTH.userId,
      scanKeywordsText: "compressor failure\nproof of purchase",
    },
  ]);
  assert.deepEqual(harness.revalidatedPaths, ["/dashboard/settings/extraction", "/dashboard"]);
});

function createHarness(
  overrides: Partial<Parameters<typeof createExtractionSettingsActionHandlers>[0]> = {},
) {
  const harness = {
    updateCalls: [] as Array<{
      organizationId: string;
      actorUserId: string;
      scanKeywordsText: string;
    }>,
    revalidatedPaths: [] as string[],
    handlers: createExtractionSettingsActionHandlers({
      getAuthContextFn: async () => DEFAULT_AUTH,
      hasMinimumRoleFn: (currentRole, requiredRole) =>
        rankRole(currentRole) >= rankRole(requiredRole),
      redirectFn: (location: string) => {
        throw new RedirectSignal(location);
      },
      revalidatePathFn: (path: string) => {
        harness.revalidatedPaths.push(path);
      },
      updateOrganizationExtractionSettingsFn: async (input) => {
        harness.updateCalls.push(input);
        return {
          kind: "no_changes",
          scanKeywords: [],
        };
      },
      ...overrides,
    }),
  };

  return harness;
}

function buildFormData(): FormData {
  const formData = new FormData();
  formData.set("scanKeywords", "compressor failure\nproof of purchase");
  return formData;
}

async function expectRedirect(action: () => Promise<void>, location: string): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof RedirectSignal && error.location === location,
  );
}

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
