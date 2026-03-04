import { prisma } from "@claimflow/db";
import { type ClaimFilters, buildClaimWhereInput } from "./filters";

export type WorkerFailureEvent = {
  source: "worker_failure";
  occurredAt: string;
  reason: string | null;
  retryable: boolean | null;
  receiveCount: number | null;
  failureDisposition: string | null;
  fromStatus: string | null;
  toStatus: string | null;
};

export type ErrorClaimRecord = {
  id: string;
  externalClaimId: string | null;
  sourceEmail: string | null;
  customerName: string | null;
  productName: string | null;
  status: string;
  warrantyStatus: string;
  createdAt: string;
  updatedAt: string;
  failure: WorkerFailureEvent | null;
};

export async function listErrorClaims(input: {
  organizationId: string;
  filters: ClaimFilters;
  limit: number;
}): Promise<{ claims: ErrorClaimRecord[]; count: number }> {
  const where = buildClaimWhereInput(input.organizationId, {
    ...input.filters,
    status: "ERROR",
  });

  const claims = await prisma.claim.findMany({
    where,
    orderBy: {
      updatedAt: "desc",
    },
    take: input.limit,
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

  const mapped = claims.map((claim) => {
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
      createdAt: claim.createdAt.toISOString(),
      updatedAt: claim.updatedAt.toISOString(),
      failure: failure ?? null,
    };
  });

  return {
    claims: mapped,
    count: mapped.length,
  };
}

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
