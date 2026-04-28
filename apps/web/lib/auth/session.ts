import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "claimflow_session";
export const PENDING_LOGIN_COOKIE_NAME = "claimflow_pending_login";
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const DEFAULT_PENDING_LOGIN_TTL_SECONDS = 60 * 5;

export const MEMBERSHIP_ROLES = ["OWNER", "ADMIN", "ANALYST", "VIEWER"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export function isMembershipRole(value: unknown): value is MembershipRole {
  return typeof value === "string" && MEMBERSHIP_ROLES.some((role) => role === value);
}

type SessionPayload = {
  userId: string;
  organizationId: string;
  role: MembershipRole;
  exp: number;
};

type PendingLoginPayload = {
  userId: string;
  redirectTo: string | null;
  exp: number;
};

export function createSessionToken(
  input: Omit<SessionPayload, "exp">,
  ttlSeconds = DEFAULT_SESSION_TTL_SECONDS,
): string {
  return createSignedToken({
    ...input,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
}

export function verifySessionToken(token: string): SessionPayload | null {
  return verifySignedToken(token, isSessionPayload);
}

export function createPendingLoginToken(
  input: Omit<PendingLoginPayload, "exp">,
  ttlSeconds = DEFAULT_PENDING_LOGIN_TTL_SECONDS,
): string {
  return createSignedToken({
    ...input,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
}

export function verifyPendingLoginToken(token: string): PendingLoginPayload | null {
  return verifySignedToken(token, isPendingLoginPayload);
}

export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: DEFAULT_SESSION_TTL_SECONDS,
  };
}

export function getPendingLoginCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: DEFAULT_PENDING_LOGIN_TTL_SECONDS,
  };
}

export function getExpiredSessionCookieOptions() {
  return {
    ...getSessionCookieOptions(),
    maxAge: 0,
  };
}

export function getExpiredPendingLoginCookieOptions() {
  return {
    ...getPendingLoginCookieOptions(),
    maxAge: 0,
  };
}

function createSignedToken<TPayload extends { exp: number }>(payload: TPayload): string {
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = signPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifySignedToken<TPayload extends { exp: number }>(
  token: string,
  isPayload: (payload: Partial<TPayload>) => payload is TPayload,
): TPayload | null {
  const [encodedPayload, providedSignature] = token.split(".");
  if (!encodedPayload || !providedSignature) {
    return null;
  }

  const expectedSignature = signPayload(encodedPayload);
  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (providedBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload)) as Partial<TPayload>;
    if (!isPayload(payload)) {
      return null;
    }

    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (secret && secret.length >= 32) {
    return secret;
  }

  if (process.env.NODE_ENV === "test") {
    return "test-only-insecure-session-secret-change-me";
  }

  throw new Error(
    "SESSION_SECRET must be set in all non-test environments and at least 32 characters long.",
  );
}

function signPayload(payload: string): string {
  const signature = createHmac("sha256", getSessionSecret()).update(payload).digest("base64url");
  return signature;
}

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function isPendingLoginPayload(
  payload: Partial<PendingLoginPayload>,
): payload is PendingLoginPayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  return (
    typeof payload.userId === "string" &&
    typeof payload.exp === "number" &&
    (payload.redirectTo === null || typeof payload.redirectTo === "string")
  );
}

function isSessionPayload(payload: Partial<SessionPayload>): payload is SessionPayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  return (
    typeof payload.userId === "string" &&
    typeof payload.organizationId === "string" &&
    typeof payload.exp === "number" &&
    isMembershipRole(payload.role)
  );
}
