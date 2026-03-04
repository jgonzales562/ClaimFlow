import { prisma } from "@claimflow/db";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getAuthContext, hasMinimumRole } from "@/lib/auth/server";
import {
  buildClaimWhereInput,
  clampLimit,
  parseClaimFiltersFromUrlSearchParams,
} from "@/lib/claims/filters";
import { captureWebException } from "@/lib/observability/sentry";
import { extractErrorMessage, logError } from "@/lib/observability/log";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasMinimumRole(auth.role, "VIEWER")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const limit = clampLimit(request.nextUrl.searchParams.get("limit"), 25, 1, 100);
    const filters = parseClaimFiltersFromUrlSearchParams(request.nextUrl.searchParams);

    const claims = await prisma.claim.findMany({
      where: buildClaimWhereInput(auth.organizationId, filters),
      orderBy: {
        createdAt: "desc",
      },
      take: limit,
      select: {
        id: true,
        externalClaimId: true,
        customerName: true,
        productName: true,
        status: true,
        warrantyStatus: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({
      claims,
      count: claims.length,
      organizationId: auth.organizationId,
      filters: {
        status: filters.status,
        search: filters.search,
        createdFrom: filters.createdFrom?.toISOString().slice(0, 10) ?? null,
        createdTo: filters.createdTo?.toISOString().slice(0, 10) ?? null,
      },
    });
  } catch (error: unknown) {
    captureWebException(error, {
      route: "/api/claims",
      organizationId: auth.organizationId,
      userId: auth.userId,
    });

    logError("claims_list_failed", {
      organizationId: auth.organizationId,
      userId: auth.userId,
      error: extractErrorMessage(error),
    });

    return NextResponse.json({ error: "Unable to fetch claims" }, { status: 500 });
  }
}
