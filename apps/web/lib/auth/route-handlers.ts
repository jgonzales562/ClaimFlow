import { prisma } from "@claimflow/db";
import { verifyPassword } from "./password";
import {
  createPendingLoginToken,
  createSessionToken,
  getExpiredPendingLoginCookieOptions,
  getExpiredSessionCookieOptions,
  getPendingLoginCookieOptions,
  getSessionCookieOptions,
  isMembershipRole,
  PENDING_LOGIN_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  verifyPendingLoginToken,
  type MembershipRole,
} from "./session";

const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password.";
const INVALID_ORGANIZATION_SELECTION_MESSAGE = "Select a valid organization to continue.";
const INVALID_ROLE_MESSAGE = "User has an invalid organization role. Contact an administrator.";
const MULTIPLE_MEMBERSHIPS_MESSAGE =
  "User belongs to multiple organizations. Organization selection is required.";
const NO_MEMBERSHIP_MESSAGE = "User has no organization membership. Contact an administrator.";
const ORGANIZATION_SELECTION_EXPIRED_MESSAGE =
  "Organization selection expired. Sign in again.";

const loginUserSelect = {
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
} as const;

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

type EligibleLoginMembershipRecord = LoginMembershipRecord & {
  role: MembershipRole;
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
  findUserByIdFn?: (userId: string) => Promise<LoginUserRecord | null>;
  verifyPasswordFn?: typeof verifyPassword;
  createSessionTokenFn?: typeof createSessionToken;
  createPendingLoginTokenFn?: typeof createPendingLoginToken;
  verifyPendingLoginTokenFn?: typeof verifyPendingLoginToken;
  getSessionCookieOptionsFn?: typeof getSessionCookieOptions;
  getPendingLoginCookieOptionsFn?: typeof getPendingLoginCookieOptions;
  getExpiredPendingLoginCookieOptionsFn?: typeof getExpiredPendingLoginCookieOptions;
};

type LogoutDependencies = {
  getExpiredSessionCookieOptionsFn?: typeof getExpiredSessionCookieOptions;
  getExpiredPendingLoginCookieOptionsFn?: typeof getExpiredPendingLoginCookieOptions;
};

type ParsedFormLoginRequest = {
  intent: "credentials" | "select_organization";
  email: string | null;
  password: string | null;
  organizationId: string | null;
  redirectTo: string | null;
};

type ParsedJsonLoginRequest =
  | {
      kind: "credentials";
      email: string;
      password: string;
    }
  | {
      kind: "select_organization";
      organizationId: string;
      pendingLoginToken: string;
    };

type EligibleMembershipSelection =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "multiple"; memberships: EligibleLoginMembershipRecord[] }
  | { kind: "single"; membership: EligibleLoginMembershipRecord };

export function createLoginHandler(dependencies: LoginDependencies = {}) {
  const findUserByEmailFn =
    dependencies.findUserByEmailFn ??
    (async (email: string) =>
      prisma.user.findUnique({
        where: { email },
        select: loginUserSelect,
      }));
  const findUserByIdFn =
    dependencies.findUserByIdFn ??
    (async (userId: string) =>
      prisma.user.findUnique({
        where: { id: userId },
        select: loginUserSelect,
      }));
  const verifyPasswordFn = dependencies.verifyPasswordFn ?? verifyPassword;
  const createSessionTokenFn = dependencies.createSessionTokenFn ?? createSessionToken;
  const createPendingLoginTokenFn =
    dependencies.createPendingLoginTokenFn ?? createPendingLoginToken;
  const verifyPendingLoginTokenFn =
    dependencies.verifyPendingLoginTokenFn ?? verifyPendingLoginToken;
  const getSessionCookieOptionsFn =
    dependencies.getSessionCookieOptionsFn ?? getSessionCookieOptions;
  const getPendingLoginCookieOptionsFn =
    dependencies.getPendingLoginCookieOptionsFn ?? getPendingLoginCookieOptions;
  const getExpiredPendingLoginCookieOptionsFn =
    dependencies.getExpiredPendingLoginCookieOptionsFn ?? getExpiredPendingLoginCookieOptions;

  return async function POST(request: Request): Promise<Response> {
    const isJsonRequest =
      request.headers.get("content-type")?.includes("application/json") ?? false;
    const formRequest = isJsonRequest ? null : await parseFormLoginRequest(request);
    const jsonRequest = isJsonRequest ? await parseJsonLoginRequest(request) : null;

    if (isJsonRequest && jsonRequest?.kind === "select_organization") {
      return finalizeSelectedOrganizationSession({
        request,
        isJsonRequest: true,
        userLoader: findUserByIdFn,
        createSessionTokenFn,
        verifyPendingLoginTokenFn,
        getSessionCookieOptionsFn,
        getExpiredPendingLoginCookieOptionsFn,
        organizationId: jsonRequest.organizationId,
        pendingLoginToken: jsonRequest.pendingLoginToken,
        redirectTo: null,
      });
    }

    if (!isJsonRequest && formRequest?.intent === "select_organization") {
      return finalizeSelectedOrganizationSession({
        request,
        isJsonRequest: false,
        userLoader: findUserByIdFn,
        createSessionTokenFn,
        verifyPendingLoginTokenFn,
        getSessionCookieOptionsFn,
        getExpiredPendingLoginCookieOptionsFn,
        organizationId: formRequest.organizationId,
        pendingLoginToken: readRequestCookie(request, PENDING_LOGIN_COOKIE_NAME),
        redirectTo: formRequest.redirectTo,
      });
    }

    const credentials = isJsonRequest
      ? jsonRequest?.kind === "credentials"
        ? jsonRequest
        : null
      : formRequest?.intent === "credentials" && formRequest.email && formRequest.password
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
    const password = credentials.password;
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

    const membershipSelection = selectEligibleMembership(user.memberships);
    if (membershipSelection.kind === "missing") {
      return isJsonRequest
        ? Response.json({ error: NO_MEMBERSHIP_MESSAGE }, { status: 403 })
        : buildLoginErrorRedirect(request, "no_membership", formRequest?.redirectTo);
    }

    if (membershipSelection.kind === "invalid") {
      return isJsonRequest
        ? Response.json({ error: INVALID_ROLE_MESSAGE }, { status: 403 })
        : buildLoginErrorRedirect(request, "invalid_role", formRequest?.redirectTo);
    }

    if (membershipSelection.kind === "multiple") {
      const pendingLoginToken = createPendingLoginTokenFn({
        userId: user.id,
        redirectTo: formRequest?.redirectTo ?? null,
      });

      if (isJsonRequest) {
        return Response.json(
          {
            error: MULTIPLE_MEMBERSHIPS_MESSAGE,
            pendingLoginToken,
            organizations: membershipSelection.memberships.map((membership) => ({
              id: membership.organization.id,
              name: membership.organization.name,
              slug: membership.organization.slug,
              role: membership.role,
            })),
          },
          { status: 409 },
        );
      }

      const response = buildOrganizationSelectionRedirect(request, formRequest?.redirectTo ?? null);
      response.headers.append(
        "set-cookie",
        serializeCookie(
          PENDING_LOGIN_COOKIE_NAME,
          pendingLoginToken,
          getPendingLoginCookieOptionsFn(),
        ),
      );
      return response;
    }

    return buildAuthenticatedLoginResponse({
      request,
      isJsonRequest,
      user,
      membership: membershipSelection.membership,
      createSessionTokenFn,
      getSessionCookieOptionsFn,
      getExpiredPendingLoginCookieOptionsFn,
      redirectTo: formRequest?.redirectTo ?? null,
    });
  };
}

export function createLogoutHandler(dependencies: LogoutDependencies = {}) {
  const getExpiredSessionCookieOptionsFn =
    dependencies.getExpiredSessionCookieOptionsFn ?? getExpiredSessionCookieOptions;
  const getExpiredPendingLoginCookieOptionsFn =
    dependencies.getExpiredPendingLoginCookieOptionsFn ?? getExpiredPendingLoginCookieOptions;

  return async function POST(request: Request): Promise<Response> {
    const isJsonRequest =
      request.headers.get("content-type")?.includes("application/json") ?? false;

    const response = isJsonRequest
      ? Response.json({ ok: true })
      : redirectResponse(new URL("/login", request.url), 303);

    response.headers.append(
      "set-cookie",
      serializeCookie(SESSION_COOKIE_NAME, "", getExpiredSessionCookieOptionsFn()),
    );
    response.headers.append(
      "set-cookie",
      serializeCookie(
        PENDING_LOGIN_COOKIE_NAME,
        "",
        getExpiredPendingLoginCookieOptionsFn(),
      ),
    );
    return response;
  };
}

async function finalizeSelectedOrganizationSession(input: {
  request: Request;
  isJsonRequest: boolean;
  userLoader: (userId: string) => Promise<LoginUserRecord | null>;
  createSessionTokenFn: typeof createSessionToken;
  verifyPendingLoginTokenFn: typeof verifyPendingLoginToken;
  getSessionCookieOptionsFn: typeof getSessionCookieOptions;
  getExpiredPendingLoginCookieOptionsFn: typeof getExpiredPendingLoginCookieOptions;
  organizationId: string | null;
  pendingLoginToken: string | null;
  redirectTo: string | null;
}): Promise<Response> {
  if (!input.organizationId) {
    return input.isJsonRequest
      ? Response.json({ error: INVALID_ORGANIZATION_SELECTION_MESSAGE }, { status: 400 })
      : buildOrganizationSelectionErrorRedirect(
          input.request,
          "invalid_organization",
          input.redirectTo,
        );
  }

  if (!input.pendingLoginToken) {
    return input.isJsonRequest
      ? Response.json({ error: ORGANIZATION_SELECTION_EXPIRED_MESSAGE }, { status: 401 })
      : buildLoginErrorRedirect(input.request, "selection_expired", input.redirectTo);
  }

  const pendingPayload = input.verifyPendingLoginTokenFn(input.pendingLoginToken);
  if (!pendingPayload) {
    return input.isJsonRequest
      ? Response.json({ error: ORGANIZATION_SELECTION_EXPIRED_MESSAGE }, { status: 401 })
      : buildLoginErrorRedirect(input.request, "selection_expired", input.redirectTo);
  }

  const user = await input.userLoader(pendingPayload.userId);
  if (!user) {
    return input.isJsonRequest
      ? Response.json({ error: ORGANIZATION_SELECTION_EXPIRED_MESSAGE }, { status: 401 })
      : buildLoginErrorRedirect(input.request, "selection_expired", pendingPayload.redirectTo);
  }

  const eligibleMemberships = getEligibleMemberships(user.memberships);
  if (eligibleMemberships.length === 0) {
    if (user.memberships.length === 0) {
      return input.isJsonRequest
        ? Response.json({ error: NO_MEMBERSHIP_MESSAGE }, { status: 403 })
        : buildLoginErrorRedirect(input.request, "no_membership", pendingPayload.redirectTo);
    }

    return input.isJsonRequest
      ? Response.json({ error: INVALID_ROLE_MESSAGE }, { status: 403 })
      : buildLoginErrorRedirect(input.request, "invalid_role", pendingPayload.redirectTo);
  }

  const selectedMembership = eligibleMemberships.find(
    (membership) => membership.organizationId === input.organizationId,
  );
  if (!selectedMembership) {
    return input.isJsonRequest
      ? Response.json({ error: INVALID_ORGANIZATION_SELECTION_MESSAGE }, { status: 403 })
      : buildOrganizationSelectionErrorRedirect(
          input.request,
          "invalid_organization",
          pendingPayload.redirectTo,
        );
  }

  return buildAuthenticatedLoginResponse({
    request: input.request,
    isJsonRequest: input.isJsonRequest,
    user,
    membership: selectedMembership,
    createSessionTokenFn: input.createSessionTokenFn,
    getSessionCookieOptionsFn: input.getSessionCookieOptionsFn,
    getExpiredPendingLoginCookieOptionsFn: input.getExpiredPendingLoginCookieOptionsFn,
    redirectTo: pendingPayload.redirectTo,
  });
}

function buildAuthenticatedLoginResponse(input: {
  request: Request;
  isJsonRequest: boolean;
  user: LoginUserRecord;
  membership: EligibleLoginMembershipRecord;
  createSessionTokenFn: typeof createSessionToken;
  getSessionCookieOptionsFn: typeof getSessionCookieOptions;
  getExpiredPendingLoginCookieOptionsFn: typeof getExpiredPendingLoginCookieOptions;
  redirectTo: string | null;
}): Response {
  const token = input.createSessionTokenFn({
    userId: input.user.id,
    organizationId: input.membership.organizationId,
    role: input.membership.role,
  });

  const response = input.isJsonRequest
    ? Response.json({
        user: {
          id: input.user.id,
          email: input.user.email,
          fullName: input.user.fullName,
          role: input.membership.role,
        },
        organization: input.membership.organization,
      })
    : redirectResponse(new URL(input.redirectTo ?? "/dashboard", input.request.url), 303);

  response.headers.append(
    "set-cookie",
    serializeCookie(SESSION_COOKIE_NAME, token, input.getSessionCookieOptionsFn()),
  );
  response.headers.append(
    "set-cookie",
    serializeCookie(
      PENDING_LOGIN_COOKIE_NAME,
      "",
      input.getExpiredPendingLoginCookieOptionsFn(),
    ),
  );
  return response;
}

async function parseJsonLoginRequest(request: Request): Promise<ParsedJsonLoginRequest | null> {
  try {
    const body = (await request.json()) as unknown;
    if (typeof body !== "object" || body === null) {
      return null;
    }

    const organizationId = readJsonOrganizationIdField(body);
    const pendingLoginToken = readJsonPendingLoginTokenField(body);
    if (organizationId && pendingLoginToken) {
      return {
        kind: "select_organization",
        organizationId,
        pendingLoginToken,
      };
    }

    const email = readJsonEmailField(body);
    const password = readJsonPasswordField(body);
    return email && password
      ? {
          kind: "credentials",
          email,
          password,
        }
      : null;
  } catch {
    return null;
  }
}

async function parseFormLoginRequest(request: Request): Promise<ParsedFormLoginRequest | null> {
  try {
    const formData = await request.formData();
    return {
      intent: readFormIntentField(formData.get("intent")),
      email: readFormEmailField(formData.get("email")),
      password: readFormPasswordField(formData.get("password")),
      organizationId: readFormOrganizationIdField(formData.get("organizationId")),
      redirectTo: sanitizeLoginRedirectTarget(formData.get("redirect")),
    };
  } catch {
    return null;
  }
}

function readJsonEmailField(value: unknown): string | null {
  return readJsonStringField(value, "email", { trim: true });
}

function readJsonPasswordField(value: unknown): string | null {
  return readJsonStringField(value, "password", { trim: false });
}

function readJsonOrganizationIdField(value: unknown): string | null {
  return readJsonStringField(value, "organizationId", { trim: true });
}

function readJsonPendingLoginTokenField(value: unknown): string | null {
  return readJsonStringField(value, "pendingLoginToken", { trim: true });
}

function readJsonStringField(
  value: unknown,
  field: "email" | "organizationId" | "password" | "pendingLoginToken",
  options: { trim: boolean },
): string | null {
  if (typeof value !== "object" || value === null || !(field in value)) {
    return null;
  }

  const fieldValue = (value as Record<string, unknown>)[field];
  if (typeof fieldValue !== "string") {
    return null;
  }

  if (options.trim) {
    return fieldValue.trim() ? fieldValue.trim() : null;
  }

  return fieldValue.length > 0 ? fieldValue : null;
}

function readFormEmailField(value: FormDataEntryValue | null): string | null {
  return readFormStringField(value, { trim: true });
}

function readFormPasswordField(value: FormDataEntryValue | null): string | null {
  return readFormStringField(value, { trim: false });
}

function readFormOrganizationIdField(value: FormDataEntryValue | null): string | null {
  return readFormStringField(value, { trim: true });
}

function readFormStringField(
  value: FormDataEntryValue | null,
  options: { trim: boolean },
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  if (options.trim) {
    return value.trim() ? value.trim() : null;
  }

  return value.length > 0 ? value : null;
}

function readFormIntentField(value: FormDataEntryValue | null): "credentials" | "select_organization" {
  return value === "select_organization" ? "select_organization" : "credentials";
}

function getEligibleMemberships(
  memberships: LoginMembershipRecord[],
): EligibleLoginMembershipRecord[] {
  return memberships.filter((membership): membership is EligibleLoginMembershipRecord =>
    isMembershipRole(membership.role),
  );
}

function selectEligibleMembership(
  memberships: LoginMembershipRecord[],
): EligibleMembershipSelection {
  if (memberships.length === 0) {
    return { kind: "missing" };
  }

  const eligibleMemberships = getEligibleMemberships(memberships);
  if (eligibleMemberships.length === 0) {
    return { kind: "invalid" };
  }

  if (eligibleMemberships.length > 1) {
    return {
      kind: "multiple",
      memberships: eligibleMemberships,
    };
  }

  return {
    kind: "single",
    membership: eligibleMemberships[0],
  };
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

function buildOrganizationSelectionRedirect(request: Request, redirectTo: string | null): Response {
  const redirectUrl = new URL("/login", request.url);
  redirectUrl.searchParams.set("select_org", "1");
  if (redirectTo) {
    redirectUrl.searchParams.set("redirect", redirectTo);
  }
  return redirectResponse(redirectUrl, 303);
}

function buildOrganizationSelectionErrorRedirect(
  request: Request,
  error: string,
  redirectTo: string | null,
): Response {
  const redirectUrl = new URL("/login", request.url);
  redirectUrl.searchParams.set("select_org", "1");
  redirectUrl.searchParams.set("error", error);
  if (redirectTo) {
    redirectUrl.searchParams.set("redirect", redirectTo);
  }
  return redirectResponse(redirectUrl, 303);
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

function readRequestCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }

  const prefix = `${name}=`;
  for (const segment of cookieHeader.split(";")) {
    const trimmed = segment.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }

  return null;
}

function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const segments = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    "HttpOnly",
  ];

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
