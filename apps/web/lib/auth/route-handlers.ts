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

    const credentials = isJsonRequest
      ? await parseJsonCredentials(request)
      : await parseFormCredentials(request);

    if (!credentials) {
      return isJsonRequest
        ? Response.json({ error: INVALID_CREDENTIALS_MESSAGE }, { status: 400 })
        : buildLoginErrorRedirect(request);
    }

    const email = credentials.email.toLowerCase().trim();
    const password = credentials.password.trim();

    const user = await findUserByEmailFn(email);

    if (!user || !user.passwordHash) {
      return isJsonRequest
        ? Response.json({ error: INVALID_CREDENTIALS_MESSAGE }, { status: 401 })
        : buildLoginErrorRedirect(request);
    }

    const isPasswordValid = await verifyPasswordFn(password, user.passwordHash);
    if (!isPasswordValid) {
      return isJsonRequest
        ? Response.json({ error: INVALID_CREDENTIALS_MESSAGE }, { status: 401 })
        : buildLoginErrorRedirect(request);
    }

    const membership = user.memberships[0];
    if (!membership) {
      return isJsonRequest
        ? Response.json(
            { error: "User has no organization membership. Contact an administrator." },
            { status: 403 },
          )
        : buildLoginErrorRedirect(request, "no_membership");
    }

    if (user.memberships.length > 1) {
      return isJsonRequest
        ? Response.json(
            { error: MULTIPLE_MEMBERSHIPS_MESSAGE },
            { status: 409 },
          )
        : buildLoginErrorRedirect(request, "multiple_memberships");
    }

    if (!isMembershipRole(membership.role)) {
      return isJsonRequest
        ? Response.json(
            { error: "User has an invalid organization role. Contact an administrator." },
            { status: 403 },
          )
        : buildLoginErrorRedirect(request, "invalid_role");
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
      : redirectResponse(new URL("/dashboard", request.url), 303);

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

async function parseFormCredentials(
  request: Request,
): Promise<{ email: string; password: string } | null> {
  try {
    const formData = await request.formData();
    const email = formData.get("email");
    const password = formData.get("password");
    if (typeof email !== "string" || typeof password !== "string") {
      return null;
    }

    if (!email.trim() || !password.trim()) {
      return null;
    }

    return { email, password };
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

function buildLoginErrorRedirect(request: Request, error = "invalid_credentials"): Response {
  const redirectUrl = new URL("/login", request.url);
  redirectUrl.searchParams.set("error", error);
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
