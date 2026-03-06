import { prisma } from "@claimflow/db";
import type { Prisma } from "@prisma/client";
import {
  applyTimestampCursor,
  encodeTimestampCursor,
  parsePageDirection,
  parseTimestampCursor,
  type PageDirection,
  type TimestampCursor,
} from "./cursor-pagination";
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

export type ErrorClaimsCursor = TimestampCursor;
export type ErrorClaimsPageDirection = PageDirection;

const errorClaimsOrderByDesc: Prisma.ClaimOrderByWithRelationInput[] = [
  { updatedAt: "desc" },
  { id: "desc" },
];

const errorClaimsOrderByAsc: Prisma.ClaimOrderByWithRelationInput[] = [
  { updatedAt: "asc" },
  { id: "asc" },
];

export async function listErrorClaims(input: {
  organizationId: string;
  filters: ClaimFilters;
  limit: number;
  cursor: ErrorClaimsCursor | null;
  direction: ErrorClaimsPageDirection;
}): Promise<{
  claims: ErrorClaimRecord[];
  totalCount: number;
  nextCursor: string | null;
  prevCursor: string | null;
}> {
  const baseWhere = buildClaimWhereInput(input.organizationId, {
    ...input.filters,
    status: "ERROR",
  });
  const where = applyTimestampCursor(baseWhere, input.cursor, input.direction, "updatedAt");

  const [claimsWindow, totalCount] = await Promise.all([
    prisma.claim.findMany({
      where,
      orderBy: input.direction === "prev" ? errorClaimsOrderByAsc : errorClaimsOrderByDesc,
      take: input.limit + 1,
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
            payload: {
              path: ["source"],
              equals: "worker_failure",
            },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            createdAt: true,
            payload: true,
          },
        },
      },
    }),
    prisma.claim.count({
      where: baseWhere,
    }),
  ]);

  const hasMoreInDirection = claimsWindow.length > input.limit;
  const pageSlice = hasMoreInDirection ? claimsWindow.slice(0, input.limit) : claimsWindow;
  const claims = input.direction === "prev" ? [...pageSlice].reverse() : pageSlice;

  const mapped = claims.map((claim) => {
    const latestTransition = claim.events[0];
    const failure = latestTransition
      ? toWorkerFailureEvent(latestTransition.payload, latestTransition.createdAt)
      : null;

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

  const first = claims[0] ?? null;
  const last = claims[claims.length - 1] ?? null;

  const nextCursor = last
    ? input.direction === "prev"
      ? encodeTimestampCursor({ timestamp: last.updatedAt, id: last.id })
      : hasMoreInDirection
        ? encodeTimestampCursor({ timestamp: last.updatedAt, id: last.id })
        : null
    : null;

  const prevCursor = first
    ? input.direction === "prev"
      ? hasMoreInDirection
        ? encodeTimestampCursor({ timestamp: first.updatedAt, id: first.id })
        : null
      : input.cursor
        ? encodeTimestampCursor({ timestamp: first.updatedAt, id: first.id })
        : null
    : null;

  return {
    claims: mapped,
    totalCount,
    nextCursor,
    prevCursor,
  };
}

export function parseErrorClaimsCursor(value: string | null): ErrorClaimsCursor | null {
  return parseTimestampCursor(value);
}

export function parseErrorClaimsPageDirection(value: string | null): ErrorClaimsPageDirection {
  return parsePageDirection(value);
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
