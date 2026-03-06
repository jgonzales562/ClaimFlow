import { prisma } from "@claimflow/db";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { verifyPassword } from "@/lib/auth/password";
import {
  createSessionToken,
  getSessionCookieOptions,
  isMembershipRole,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/session";

const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password.";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const isJsonRequest = request.headers.get("content-type")?.includes("application/json") ?? false;

  const credentials = isJsonRequest
    ? await parseJsonCredentials(request)
    : await parseFormCredentials(request);

  if (!credentials) {
    return isJsonRequest
      ? NextResponse.json({ error: INVALID_CREDENTIALS_MESSAGE }, { status: 400 })
      : buildLoginErrorRedirect(request);
  }

  const email = credentials.email.toLowerCase().trim();
  const password = credentials.password.trim();

  const user = await prisma.user.findUnique({
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
  });

  if (!user || !user.passwordHash) {
    return isJsonRequest
      ? NextResponse.json({ error: INVALID_CREDENTIALS_MESSAGE }, { status: 401 })
      : buildLoginErrorRedirect(request);
  }

  const isPasswordValid = await verifyPassword(password, user.passwordHash);
  if (!isPasswordValid) {
    return isJsonRequest
      ? NextResponse.json({ error: INVALID_CREDENTIALS_MESSAGE }, { status: 401 })
      : buildLoginErrorRedirect(request);
  }

  const membership = user.memberships[0];
  if (!membership) {
    return isJsonRequest
      ? NextResponse.json(
          { error: "User has no organization membership. Contact an administrator." },
          { status: 403 },
        )
      : buildLoginErrorRedirect(request, "no_membership");
  }

  if (!isMembershipRole(membership.role)) {
    return isJsonRequest
      ? NextResponse.json(
          { error: "User has an invalid organization role. Contact an administrator." },
          { status: 403 },
        )
      : buildLoginErrorRedirect(request, "invalid_role");
  }

  const token = createSessionToken({
    userId: user.id,
    organizationId: membership.organizationId,
    role: membership.role,
  });

  const response = isJsonRequest
    ? NextResponse.json({
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          role: membership.role,
        },
        organization: membership.organization,
      })
    : NextResponse.redirect(new URL("/dashboard", request.url), { status: 303 });

  response.cookies.set(SESSION_COOKIE_NAME, token, getSessionCookieOptions());
  return response;
}

async function parseJsonCredentials(
  request: NextRequest,
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
  request: NextRequest,
): Promise<{ email: string; password: string } | null> {
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

function buildLoginErrorRedirect(request: NextRequest, error = "invalid_credentials"): NextResponse {
  const redirectUrl = new URL("/login", request.url);
  redirectUrl.searchParams.set("error", error);
  return NextResponse.redirect(redirectUrl, { status: 303 });
}
