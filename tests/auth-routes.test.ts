import assert from "node:assert/strict";
import { test } from "node:test";
import { createLoginHandler, createLogoutHandler } from "../apps/web/lib/auth/route-handlers.ts";

const baseUser = {
  id: "user-1",
  email: "analyst@example.com",
  fullName: "Ava Analyst",
  passwordHash: "hashed-password",
  memberships: [
    {
      organizationId: "org-1",
      role: "ANALYST",
      organization: {
        id: "org-1",
        name: "ClaimFlow",
        slug: "claimflow",
      },
    },
  ],
} as const;

const multiOrgUser = {
  ...baseUser,
  memberships: [
    ...baseUser.memberships,
    {
      organizationId: "org-2",
      role: "ADMIN",
      organization: {
        id: "org-2",
        name: "ClaimFlow West",
        slug: "claimflow-west",
      },
    },
  ],
} as const;

test("login JSON rejects malformed credentials payloads", async () => {
  const handler = createLoginHandler();

  const response = await handler(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "", password: "" }),
    }),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid email or password." });
});

test("login JSON rejects invalid credentials", async () => {
  const handler = createLoginHandler({
    findUserByEmailFn: async () => ({ ...baseUser }),
    verifyPasswordFn: async () => false,
  });

  const response = await handler(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "analyst@example.com", password: "wrong-password" }),
    }),
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Invalid email or password." });
});

test("login JSON preserves leading and trailing spaces in passwords", async () => {
  let receivedPassword: string | null = null;
  const handler = createLoginHandler({
    findUserByEmailFn: async () => ({ ...baseUser }),
    verifyPasswordFn: async (password) => {
      receivedPassword = password;
      return password === "  correct-password  ";
    },
    createSessionTokenFn: () => "session-token-value",
  });

  const response = await handler(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "analyst@example.com",
        password: "  correct-password  ",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(receivedPassword, "  correct-password  ");
});

test("login form redirects invalid credentials back to the login page", async () => {
  const handler = createLoginHandler({
    findUserByEmailFn: async () => null,
  });

  const formData = new FormData();
  formData.set("email", "analyst@example.com");
  formData.set("password", "wrong-password");

  const response = await handler(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      body: formData,
    }),
  );

  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    "http://localhost/login?error=invalid_credentials",
  );
});

test("login form preserves a validated redirect target when credentials are rejected", async () => {
  const handler = createLoginHandler({
    findUserByEmailFn: async () => null,
  });

  const formData = new FormData();
  formData.set("email", "analyst@example.com");
  formData.set("password", "wrong-password");
  formData.set("redirect", "/dashboard/claims/claim-1?tab=history");

  const response = await handler(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      body: formData,
    }),
  );

  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    "http://localhost/login?error=invalid_credentials&redirect=%2Fdashboard%2Fclaims%2Fclaim-1%3Ftab%3Dhistory",
  );
});

test("login JSON rejects users without memberships", async () => {
  const handler = createLoginHandler({
    findUserByEmailFn: async () => ({ ...baseUser, memberships: [] }),
    verifyPasswordFn: async () => true,
  });

  const response = await handler(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "analyst@example.com", password: "correct-password" }),
    }),
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "User has no organization membership. Contact an administrator.",
  });
});

test("login JSON returns organization options and a pending token for multi-org users", async () => {
  const handler = createLoginHandler({
    findUserByEmailFn: async () => ({ ...multiOrgUser }),
    verifyPasswordFn: async () => true,
    createPendingLoginTokenFn: () => "pending-token-value",
  });

  const response = await handler(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "analyst@example.com", password: "correct-password" }),
    }),
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "User belongs to multiple organizations. Organization selection is required.",
    pendingLoginToken: "pending-token-value",
    organizations: [
      {
        id: "org-1",
        name: "ClaimFlow",
        slug: "claimflow",
        role: "ANALYST",
      },
      {
        id: "org-2",
        name: "ClaimFlow West",
        slug: "claimflow-west",
        role: "ADMIN",
      },
    ],
  });
});

test("login form redirects multi-org users to organization selection and sets a pending cookie", async () => {
  const handler = createLoginHandler({
    findUserByEmailFn: async () => ({ ...multiOrgUser }),
    verifyPasswordFn: async () => true,
    createPendingLoginTokenFn: () => "pending-token-value",
  });

  const formData = new FormData();
  formData.set("email", "analyst@example.com");
  formData.set("password", "correct-password");
  formData.set("redirect", "/dashboard/claims/claim-1?notice=resume");

  const response = await handler(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      body: formData,
    }),
  );

  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    "http://localhost/login?select_org=1&redirect=%2Fdashboard%2Fclaims%2Fclaim-1%3Fnotice%3Dresume",
  );

  const setCookies = readSetCookieHeaders(response);
  assertHasCookie(setCookies, /^claimflow_pending_login=pending-token-value;/);
});

test("login form redirects users with invalid membership roles", async () => {
  const handler = createLoginHandler({
    findUserByEmailFn: async () => ({
      ...baseUser,
      memberships: [
        {
          ...baseUser.memberships[0],
          role: "BROKEN_ROLE",
        },
      ],
    }),
    verifyPasswordFn: async () => true,
  });

  const formData = new FormData();
  formData.set("email", "analyst@example.com");
  formData.set("password", "correct-password");

  const response = await handler(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      body: formData,
    }),
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "http://localhost/login?error=invalid_role");
});

test("organization selection JSON creates a session and clears the pending cookie", async () => {
  const handler = createLoginHandler({
    findUserByIdFn: async () => ({ ...multiOrgUser }),
    verifyPendingLoginTokenFn: () => ({
      userId: "user-1",
      redirectTo: "/dashboard/claims/claim-1?notice=resume",
      exp: 9999999999,
    }),
    createSessionTokenFn: () => "session-token-value",
  });

  const response = await handler(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        organizationId: "org-2",
        pendingLoginToken: "pending-token-value",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    user: {
      id: "user-1",
      email: "analyst@example.com",
      fullName: "Ava Analyst",
      role: "ADMIN",
    },
    organization: {
      id: "org-2",
      name: "ClaimFlow West",
      slug: "claimflow-west",
    },
  });

  const setCookies = readSetCookieHeaders(response);
  assertHasCookie(setCookies, /^claimflow_session=session-token-value;/);
  assertHasCookie(setCookies, /^claimflow_pending_login=;/);
});

test("organization selection form redirects back to the chosen dashboard path and clears the pending cookie", async () => {
  const handler = createLoginHandler({
    findUserByIdFn: async () => ({ ...multiOrgUser }),
    verifyPendingLoginTokenFn: () => ({
      userId: "user-1",
      redirectTo: "/dashboard/claims/claim-1?notice=resume",
      exp: 9999999999,
    }),
    createSessionTokenFn: () => "session-token-value",
  });

  const formData = new FormData();
  formData.set("intent", "select_organization");
  formData.set("organizationId", "org-2");
  formData.set("redirect", "/dashboard/claims/claim-1?notice=resume");

  const response = await handler(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: {
        cookie: "claimflow_pending_login=pending-token-value",
      },
      body: formData,
    }),
  );

  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    "http://localhost/dashboard/claims/claim-1?notice=resume",
  );

  const setCookies = readSetCookieHeaders(response);
  assertHasCookie(setCookies, /^claimflow_session=session-token-value;/);
  assertHasCookie(setCookies, /^claimflow_pending_login=;/);
});

test("organization selection form redirects back to the picker when the chosen org is invalid", async () => {
  const handler = createLoginHandler({
    findUserByIdFn: async () => ({ ...multiOrgUser }),
    verifyPendingLoginTokenFn: () => ({
      userId: "user-1",
      redirectTo: "/dashboard/claims/claim-1?notice=resume",
      exp: 9999999999,
    }),
  });

  const formData = new FormData();
  formData.set("intent", "select_organization");
  formData.set("organizationId", "org-missing");
  formData.set("redirect", "/dashboard/claims/claim-1?notice=resume");

  const response = await handler(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: {
        cookie: "claimflow_pending_login=pending-token-value",
      },
      body: formData,
    }),
  );

  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    "http://localhost/login?select_org=1&error=invalid_organization&redirect=%2Fdashboard%2Fclaims%2Fclaim-1%3Fnotice%3Dresume",
  );
});

test("organization selection form redirects to login when the pending selection has expired", async () => {
  const handler = createLoginHandler({
    verifyPendingLoginTokenFn: () => null,
  });

  const formData = new FormData();
  formData.set("intent", "select_organization");
  formData.set("organizationId", "org-2");
  formData.set("redirect", "/dashboard/claims/claim-1?notice=resume");

  const response = await handler(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: {
        cookie: "claimflow_pending_login=expired-token",
      },
      body: formData,
    }),
  );

  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    "http://localhost/login?error=selection_expired&redirect=%2Fdashboard%2Fclaims%2Fclaim-1%3Fnotice%3Dresume",
  );
});

test("login JSON returns session data and sets the session cookie on success", async () => {
  const handler = createLoginHandler({
    findUserByEmailFn: async () => ({ ...baseUser }),
    verifyPasswordFn: async () => true,
    createSessionTokenFn: () => "session-token-value",
  });

  const response = await handler(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ANALYST@example.com", password: "correct-password" }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    user: {
      id: "user-1",
      email: "analyst@example.com",
      fullName: "Ava Analyst",
      role: "ANALYST",
    },
    organization: {
      id: "org-1",
      name: "ClaimFlow",
      slug: "claimflow",
    },
  });

  const setCookies = readSetCookieHeaders(response);
  assertHasCookie(setCookies, /^claimflow_session=session-token-value;/);
  assertHasCookie(setCookies, /^claimflow_pending_login=;/);
});

test("login form redirects to the dashboard and sets the session cookie on success", async () => {
  const handler = createLoginHandler({
    findUserByEmailFn: async () => ({ ...baseUser }),
    verifyPasswordFn: async () => true,
    createSessionTokenFn: () => "session-token-value",
  });

  const formData = new FormData();
  formData.set("email", "analyst@example.com");
  formData.set("password", "correct-password");

  const response = await handler(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      body: formData,
    }),
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "http://localhost/dashboard");

  const setCookies = readSetCookieHeaders(response);
  assertHasCookie(setCookies, /^claimflow_session=session-token-value;/);
});

test("login form redirects back to a validated dashboard path on success", async () => {
  const handler = createLoginHandler({
    findUserByEmailFn: async () => ({ ...baseUser }),
    verifyPasswordFn: async () => true,
    createSessionTokenFn: () => "session-token-value",
  });

  const formData = new FormData();
  formData.set("email", "analyst@example.com");
  formData.set("password", "correct-password");
  formData.set("redirect", "/dashboard/claims/claim-1?notice=resume");

  const response = await handler(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      body: formData,
    }),
  );

  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    "http://localhost/dashboard/claims/claim-1?notice=resume",
  );

  const setCookies = readSetCookieHeaders(response);
  assertHasCookie(setCookies, /^claimflow_session=session-token-value;/);
});

test("login form ignores unsafe redirect targets", async () => {
  const handler = createLoginHandler({
    findUserByEmailFn: async () => ({ ...baseUser }),
    verifyPasswordFn: async () => true,
    createSessionTokenFn: () => "session-token-value",
  });

  const formData = new FormData();
  formData.set("email", "analyst@example.com");
  formData.set("password", "correct-password");
  formData.set("redirect", "https://example.com/steal-session");

  const response = await handler(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      body: formData,
    }),
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "http://localhost/dashboard");
});

test("logout JSON clears the session and pending-login cookies", async () => {
  const handler = createLogoutHandler();

  const response = await handler(
    new Request("http://localhost/api/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });

  const setCookies = readSetCookieHeaders(response);
  assertHasCookie(setCookies, /^claimflow_session=;/);
  assertHasCookie(setCookies, /^claimflow_pending_login=;/);
});

test("logout form redirects to login and clears the session and pending-login cookies", async () => {
  const handler = createLogoutHandler();

  const response = await handler(
    new Request("http://localhost/api/auth/logout", {
      method: "POST",
    }),
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "http://localhost/login");

  const setCookies = readSetCookieHeaders(response);
  assertHasCookie(setCookies, /^claimflow_session=;/);
  assertHasCookie(setCookies, /^claimflow_pending_login=;/);
});

function readSetCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const combined = response.headers.get("set-cookie");
  if (!combined) {
    return [];
  }

  return combined.split(/,(?=\s*[^;,\s]+=)/);
}

function assertHasCookie(cookies: string[], pattern: RegExp): void {
  assert.ok(
    cookies.some((value) => pattern.test(value)),
    `Expected cookie matching ${pattern}, received ${cookies.join(" | ")}`,
  );
}
