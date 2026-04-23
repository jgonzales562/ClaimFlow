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

test("login JSON rejects users with multiple memberships until org selection exists", async () => {
  const handler = createLoginHandler({
    findUserByEmailFn: async () => ({
      ...baseUser,
      memberships: [
        ...baseUser.memberships,
        {
          organizationId: "org-2",
          role: "ANALYST",
          organization: {
            id: "org-2",
            name: "ClaimFlow West",
            slug: "claimflow-west",
          },
        },
      ],
    }),
    verifyPasswordFn: async () => true,
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
  });
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

test("login form redirects users with multiple memberships back to the login page", async () => {
  const handler = createLoginHandler({
    findUserByEmailFn: async () => ({
      ...baseUser,
      memberships: [
        ...baseUser.memberships,
        {
          organizationId: "org-2",
          role: "ANALYST",
          organization: {
            id: "org-2",
            name: "ClaimFlow West",
            slug: "claimflow-west",
          },
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
  assert.equal(
    response.headers.get("location"),
    "http://localhost/login?error=multiple_memberships",
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
  assert.match(response.headers.get("set-cookie") ?? "", /^claimflow_session=session-token-value;/);
  assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.match(response.headers.get("set-cookie") ?? "", /SameSite=Lax/);
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
  assert.match(response.headers.get("set-cookie") ?? "", /^claimflow_session=session-token-value;/);
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
  assert.match(response.headers.get("set-cookie") ?? "", /^claimflow_session=session-token-value;/);
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

test("logout JSON clears the session cookie", async () => {
  const handler = createLogoutHandler();

  const response = await handler(
    new Request("http://localhost/api/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.match(response.headers.get("set-cookie") ?? "", /^claimflow_session=;/);
  assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
});

test("logout form redirects to login and clears the session cookie", async () => {
  const handler = createLogoutHandler();

  const response = await handler(
    new Request("http://localhost/api/auth/logout", {
      method: "POST",
    }),
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "http://localhost/login");
  assert.match(response.headers.get("set-cookie") ?? "", /^claimflow_session=;/);
  assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
});
