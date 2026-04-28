import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPendingLoginToken,
  createSessionToken,
  verifyPendingLoginToken,
  verifySessionToken,
} from "../apps/web/lib/auth/session.ts";

test("session tokens require SESSION_SECRET outside test environments", () => {
  withEnv(
    {
      NODE_ENV: "development",
      SESSION_SECRET: undefined,
    },
    () => {
      assert.throws(
        () =>
          createSessionToken({
            userId: "user-1",
            organizationId: "org-1",
            role: "ADMIN",
          }),
        /SESSION_SECRET must be set in all non-test environments/,
      );
    },
  );
});

test("session tokens use a test-only fallback secret when SESSION_SECRET is absent", () => {
  withEnv(
    {
      NODE_ENV: "test",
      SESSION_SECRET: undefined,
    },
    () => {
      const token = createSessionToken({
        userId: "user-1",
        organizationId: "org-1",
        role: "ADMIN",
      });

      const payload = verifySessionToken(token);
      assert.deepEqual(payload, {
        userId: "user-1",
        organizationId: "org-1",
        role: "ADMIN",
        exp: payload?.exp,
      });
      assert.equal(typeof payload?.exp, "number");
    },
  );
});

test("pending login tokens round-trip redirect state with the same signing rules", () => {
  withEnv(
    {
      NODE_ENV: "test",
      SESSION_SECRET: undefined,
    },
    () => {
      const token = createPendingLoginToken({
        userId: "user-1",
        redirectTo: "/dashboard/claims/claim-1?notice=resume",
      });

      const payload = verifyPendingLoginToken(token);
      assert.deepEqual(payload, {
        userId: "user-1",
        redirectTo: "/dashboard/claims/claim-1?notice=resume",
        exp: payload?.exp,
      });
      assert.equal(typeof payload?.exp, "number");
    },
  );
});

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  const previousValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    previousValues.set(key, process.env[key]);
    if (typeof value === "undefined") {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    run();
  } finally {
    for (const [key, value] of previousValues) {
      if (typeof value === "undefined") {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
