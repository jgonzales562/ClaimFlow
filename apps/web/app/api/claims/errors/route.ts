import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getAuthContext, hasMinimumRole } from "@/lib/auth/server";
import {
  clampLimit,
  parseClaimFiltersFromUrlSearchParams,
} from "@/lib/claims/filters";
import { listErrorClaims } from "@/lib/claims/error-claims";
import { captureWebException } from "@/lib/observability/sentry";
import { extractErrorMessage, logError, logInfo } from "@/lib/observability/log";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasMinimumRole(auth.role, "ADMIN")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const filters = parseClaimFiltersFromUrlSearchParams(request.nextUrl.searchParams);
    const limit = clampLimit(request.nextUrl.searchParams.get("limit"), 50, 1, 200);
    const payload = await listErrorClaims({
      organizationId: auth.organizationId,
      filters,
      limit,
    });

    logInfo("error_claims_list_completed", {
      organizationId: auth.organizationId,
      userId: auth.userId,
      count: payload.count,
      limit,
      hasSearch: Boolean(filters.search),
      createdFrom: filters.createdFrom?.toISOString() ?? null,
      createdTo: filters.createdTo?.toISOString() ?? null,
    });

    return NextResponse.json({
      claims: payload.claims,
      count: payload.count,
      organizationId: auth.organizationId,
      filters: {
        status: "ERROR",
        search: filters.search,
        createdFrom: filters.createdFrom?.toISOString().slice(0, 10) ?? null,
        createdTo: filters.createdTo?.toISOString().slice(0, 10) ?? null,
      },
    });
  } catch (error: unknown) {
    captureWebException(error, {
      route: "/api/claims/errors",
      organizationId: auth.organizationId,
      userId: auth.userId,
    });

    logError("error_claims_list_failed", {
      organizationId: auth.organizationId,
      userId: auth.userId,
      error: extractErrorMessage(error),
    });

    return NextResponse.json({ error: "Unable to fetch error claims" }, { status: 500 });
  }
}
