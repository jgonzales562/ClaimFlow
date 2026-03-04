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
    const where = buildClaimWhereInput(auth.organizationId, {
      ...filters,
      status: "ERROR",
    });

    const claims = await prisma.claim.findMany({
      where,
      orderBy: {
        updatedAt: "desc",
      },
      take: limit,
      select: {
        id: true,
        externalClaimId: true,
        sourceEmail: true,
        customerName: true,
        productName: true,
        status: true,
        warrantyStatus: true,
        createdAt: true,
        updatedAt: true,
        events: {
          where: {
            eventType: "STATUS_TRANSITION",
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 10,
          select: {
            createdAt: true,
            payload: true,
          },
        },
      },
    });

    const claimsWithFailure = claims.map((claim) => {
      const failure = claim.events
        .map((event) => toWorkerFailureEvent(event.payload, event.createdAt))
        .find((event): event is WorkerFailureEvent => event !== null);

      return {
        id: claim.id,
        externalClaimId: claim.externalClaimId,
        sourceEmail: claim.sourceEmail,
        customerName: claim.customerName,
        productName: claim.productName,
        status: claim.status,
        warrantyStatus: claim.warrantyStatus,
        createdAt: claim.createdAt,
        updatedAt: claim.updatedAt,
        failure,
      };
    });

    logInfo("error_claims_list_completed", {
      organizationId: auth.organizationId,
      userId: auth.userId,
      count: claimsWithFailure.length,
      limit,
      hasSearch: Boolean(filters.search),
      createdFrom: filters.createdFrom?.toISOString() ?? null,
      createdTo: filters.createdTo?.toISOString() ?? null,
    });

    return NextResponse.json({
      claims: claimsWithFailure,
      count: claimsWithFailure.length,
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

type WorkerFailureEvent = {
  source: "worker_failure";
  occurredAt: string;
  reason: string | null;
  retryable: boolean | null;
  receiveCount: number | null;
  failureDisposition: string | null;
  fromStatus: string | null;
  toStatus: string | null;
};

function toWorkerFailureEvent(payload: unknown, createdAt: Date): WorkerFailureEvent | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  if (record.source !== "worker_failure") {
    return null;
  }

  return {
    source: "worker_failure",
    occurredAt: createdAt.toISOString(),
    reason: typeof record.reason === "string" ? record.reason : null,
    retryable: typeof record.retryable === "boolean" ? record.retryable : null,
    receiveCount: typeof record.receiveCount === "number" ? record.receiveCount : null,
    failureDisposition:
      typeof record.failureDisposition === "string" ? record.failureDisposition : null,
    fromStatus: typeof record.fromStatus === "string" ? record.fromStatus : null,
    toStatus: typeof record.toStatus === "string" ? record.toStatus : null,
  };
}
