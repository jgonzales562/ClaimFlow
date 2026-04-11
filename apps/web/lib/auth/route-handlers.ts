import { prisma } from "@claimflow/db";
import { verifyPassword } from "./password";
import {
  createSessionToken,
  getExpiredSessionCookieOptions,
  getSessionCookieOptions,
  isMembershipRole,
  SESSION_COOKIE_NAME,
} from "./session";

const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password.";
const MULTIPLE_MEMBERSHIPS_MESSAGE =
  "User belongs to multiple organizations. Organization selection is required.";

type CookieOptions = ReturnType<typeof getSessionCookieOptions>;

type LoginMembershipRecord = {
  organizationId: string;
  role: string;
  organization: {
    id: string;
    name: string;
    slug: string;
  };
};

type LoginUserRecord = {
  id: string;
  email: string;
  fullName: string | null;
  passwordHash: string | null;
  memberships: LoginMembershipRecord[];
};

type LoginDependencies = {
  findUserByEmailFn?: (email: string) => Promise<LoginUserRecord | null>;
  verifyPasswordFn?: typeof verifyPassword;
  createSessionTokenFn?: typeof createSessionToken;
  getSessionCookieOptionsFn?: typeof getSessionCookieOptions;
};

type LogoutDependencies = {
  getExpiredSessionCookieOptionsFn?: typeof getExpiredSessionCookieOptions;
};

type ParsedFormLoginRequest = {
  email: string | null;
  password: string | null;
  redirectTo: string | null;
};

export function createLoginHandler(dependencies: LoginDependencies = {}) {
  const findUserByEmailFn =
    dependencies.findUserByEmailFn ??
    (async (email: string) =>
      prisma.user.findUnique({
        where: { email },
        select: {
          id: true,
          email: true,
          fullName: true,
          passwordHash: true,
          memberships: {
            select: {
              organizationId: true,
              role: true,
              organization: {
                select: {
                  id: true,
                  name: true,
                  slug: true,
                },
              },
            },
            orderBy: {
              createdAt: "asc",
            },
          },
        },
      }));
  const verifyPasswordFn = dependencies.verifyPasswordFn ?? verifyPassword;
  const createSessionTokenFn = dependencies.createSessionTokenFn ?? createSessionToken;
  const getSessionCookieOptionsFn =
    dependencies.getSessionCookieOptionsFn ?? getSessionCookieOptions;

  return async function POST(request: Request): Promise<Response> {
    const isJsonRequest = request.headers.get("content-type")?.includes("application/json") ?? false;
    const formRequest = isJsonRequest ? null : await parseFormLoginRequest(request);

    const credentials = isJsonRequest
      ? await parseJsonCredentials(request)
      : formRequest?.email && formRequest.password
        ? {
            email: formRequest.email,
            password: formRequest.password,
          }
        : null;

    if (!credentials) {
      return isJsonRequest
        ? Response.json({ error: INVALID_CREDENTIALS_MESSAGE }, { status: 400 })
        : buildLoginErrorRedirect(request, "invalid_credentials", formRequest?.redirectTo);
    }

    const email = credentials.email.toLowerCase().trim();
    const password = credentials.password.trim();

    const user = await findUserByEmailFn(email);

    if (!user || !user.passwordHash) {
      return isJsonRequest
        ? Response.json({ error: INVALID_CREDENTIALS_MESSAGE }, { status: 401 })
        : buildLoginErrorRedirect(request, "invalid_credentials", formRequest?.redirectTo);
    }

    const isPasswordValid = await verifyPasswordFn(password, user.passwordHash);
    if (!isPasswordValid) {
      return isJsonRequest
        ? Response.json({ error: INVALID_CREDENTIALS_MESSAGE }, { status: 401 })
        : buildLoginErrorRedirect(request, "invalid_credentials", formRequest?.redirectTo);
    }

    const membership = user.memberships[0];
    if (!membership) {
      return isJsonRequest
        ? Response.json(
            { error: "User has no organization membership. Contact an administrator." },
            { status: 403 },
          )
        : buildLoginErrorRedirect(request, "no_membership", formRequest?.redirectTo);
    }

    if (user.memberships.length > 1) {
      return isJsonRequest
        ? Response.json(
            { error: MULTIPLE_MEMBERSHIPS_MESSAGE },
            { status: 409 },
          )
        : buildLoginErrorRedirect(request, "multiple_memberships", formRequest?.redirectTo);
    }

    if (!isMembershipRole(membership.role)) {
      return isJsonRequest
        ? Response.json(
            { error: "User has an invalid organization role. Contact an administrator." },
            { status: 403 },
          )
        : buildLoginErrorRedirect(request, "invalid_role", formRequest?.redirectTo);
    }

    const token = createSessionTokenFn({
      userId: user.id,
      organizationId: membership.organizationId,
      role: membership.role,
    });

    const response = isJsonRequest
      ? Response.json({
          user: {
            id: user.id,
            email: user.email,
            fullName: user.fullName,
            role: membership.role,
          },
          organization: membership.organization,
        })
      : redirectResponse(new URL(formRequest?.redirectTo ?? "/dashboard", request.url), 303);

    response.headers.append(
      "set-cookie",
      serializeCookie(SESSION_COOKIE_NAME, token, getSessionCookieOptionsFn()),
    );
    return response;
  };
}

export function createLogoutHandler(dependencies: LogoutDependencies = {}) {
  const getExpiredSessionCookieOptionsFn =
    dependencies.getExpiredSessionCookieOptionsFn ?? getExpiredSessionCookieOptions;

  return async function POST(request: Request): Promise<Response> {
    const isJsonRequest = request.headers.get("content-type")?.includes("application/json") ?? false;

    const response = isJsonRequest
      ? Response.json({ ok: true })
      : redirectResponse(new URL("/login", request.url), 303);

    response.headers.append(
      "set-cookie",
      serializeCookie(SESSION_COOKIE_NAME, "", getExpiredSessionCookieOptionsFn()),
    );
    return response;
  };
}

async function parseJsonCredentials(
  request: Request,
): Promise<{ email: string; password: string } | null> {
  try {
    const body = (await request.json()) as unknown;
    if (typeof body !== "object" || body === null) {
      return null;
    }

    const email = readCredentialField(body, "email");
    const password = readCredentialField(body, "password");
    return email && password ? { email, password } : null;
  } catch {
    return null;
  }
}

async function parseFormLoginRequest(request: Request): Promise<ParsedFormLoginRequest | null> {
  try {
    const formData = await request.formData();
    return {
      email: readFormStringField(formData.get("email")),
      password: readFormStringField(formData.get("password")),
      redirectTo: sanitizeLoginRedirectTarget(formData.get("redirect")),
    };
  } catch {
    return null;
  }
}

function readCredentialField(value: unknown, field: "email" | "password"): string | null {
  if (!(field in (value as Record<string, unknown>))) {
    return null;
  }

  const fieldValue = (value as Record<string, unknown>)[field];
  if (typeof fieldValue !== "string" || !fieldValue.trim()) {
    return null;
  }

  return fieldValue;
}

function readFormStringField(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  return value;
}

function sanitizeLoginRedirectTarget(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("/dashboard") || trimmed.startsWith("//")) {
    return null;
  }

  try {
    const normalizedUrl = new URL(trimmed, "http://localhost");
    if (normalizedUrl.origin !== "http://localhost") {
      return null;
    }

    return `${normalizedUrl.pathname}${normalizedUrl.search}${normalizedUrl.hash}`;
  } catch {
    return null;
  }
}

function buildLoginErrorRedirect(
  request: Request,
  error = "invalid_credentials",
  redirectTo: string | null = null,
): Response {
  const redirectUrl = new URL("/login", request.url);
  redirectUrl.searchParams.set("error", error);
  if (redirectTo) {
    redirectUrl.searchParams.set("redirect", redirectTo);
  }
  return redirectResponse(redirectUrl, 303);
}

function redirectResponse(url: URL, status: 303): Response {
  return new Response(null, {
    status,
    headers: {
      location: url.toString(),
    },
  });
}

function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const segments = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path}`, `Max-Age=${options.maxAge}`, "HttpOnly"];

  if (options.sameSite) {
    segments.push(`SameSite=${capitalizeToken(options.sameSite)}`);
  }

  if (options.secure) {
    segments.push("Secure");
  }

  return segments.join("; ");
}

function capitalizeToken(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
