import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getExpiredSessionCookieOptions, SESSION_COOKIE_NAME } from "@/lib/auth/session";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const isJsonRequest = request.headers.get("content-type")?.includes("application/json") ?? false;

  const response = isJsonRequest
    ? NextResponse.json({ ok: true })
    : NextResponse.redirect(new URL("/login", request.url), { status: 303 });

  response.cookies.set(SESSION_COOKIE_NAME, "", getExpiredSessionCookieOptions());
  return response;
}
