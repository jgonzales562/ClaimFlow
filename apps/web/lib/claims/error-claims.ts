import { prisma } from "@claimflow/db";
import { Prisma } from "@prisma/client";
import {
  applyTimestampCursor,
  parsePageDirection,
  type PageDirection,
} from "./cursor-pagination";
import { buildClaimWhereInput, type ClaimFilters } from "./filters";
import { readWorkerFailureSnapshot, type WorkerFailureEvent } from "./worker-failure";

export type ErrorClaimRecord = {
  id: string;
  externalClaimId: string | null;
  sourceEmail: string | null;
  customerName: string | null;
  productName: string | null;
  status: string;
  warrantyStatus: string;
  processingAttempt: number;
  createdAt: string;
  updatedAt: string;
  failure: WorkerFailureEvent | null;
};

export const ERROR_CLAIM_SORTS = [
  "updated_desc",
  "receive_count_desc",
  "failure_oldest_first",
] as const;
export type ErrorClaimSort = (typeof ERROR_CLAIM_SORTS)[number];
type UpdatedErrorClaimsCursor = {
  kind: "updated";
  timestamp: Date;
  id: string;
};
type ReceiveCountErrorClaimsCursor = {
  kind: "receive_count_desc";
  receiveCount: number;
  timestamp: Date;
  id: string;
};
type FailureOldestErrorClaimsCursor = {
  kind: "failure_oldest_first";
  occurredAt: Date;
  id: string;
};
export type ErrorClaimsCursor =
  | UpdatedErrorClaimsCursor
  | ReceiveCountErrorClaimsCursor
  | FailureOldestErrorClaimsCursor;
export type ErrorClaimsPageDirection = PageDirection;
export const ERROR_CLAIM_RETRYABILITY_FILTERS = [
  "retryable",
  "non_retryable",
  "unknown",
] as const;
export type ErrorClaimRetryabilityFilter =
  (typeof ERROR_CLAIM_RETRYABILITY_FILTERS)[number];
export const ERROR_CLAIM_FAILURE_DISPOSITION_FILTERS = [
  "retrying",
  "moved_to_dlq",
  "dropped_non_retryable",
  "unknown",
] as const;
export type ErrorClaimFailureDispositionFilter =
  (typeof ERROR_CLAIM_FAILURE_DISPOSITION_FILTERS)[number];
type ErrorClaimRow = {
  id: string;
  updatedAt: Date;
  failureReceiveCount: number;
  failureOccurredAt: Date;
};

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
  retryability: ErrorClaimRetryabilityFilter | null;
  failureDisposition: ErrorClaimFailureDispositionFilter | null;
  sort: ErrorClaimSort;
  limit: number;
  cursor: ErrorClaimsCursor | null;
  direction: ErrorClaimsPageDirection;
}): Promise<{
  claims: ErrorClaimRecord[];
  totalCount: number;
  nextCursor: string | null;
  prevCursor: string | null;
}> {
  if (
    !input.retryability &&
    !input.failureDisposition &&
    input.sort === "updated_desc"
  ) {
    return listErrorClaimsWithoutRetryabilityFilter(input);
  }

  const baseWhereSql = buildErrorClaimWhereSql({
    organizationId: input.organizationId,
    filters: input.filters,
    retryability: input.retryability,
    failureDisposition: input.failureDisposition,
  });
  const cursorWhereSql = buildErrorClaimCursorWhereSql(
    input.sort,
    input.cursor,
    input.direction,
  );
  const whereSql = cursorWhereSql
    ? Prisma.sql`${baseWhereSql} AND ${cursorWhereSql}`
    : baseWhereSql;
  const [orderedClaimRows, totalCountRows] = await Promise.all([
    prisma.$queryRaw<Array<ErrorClaimRow>>(
      Prisma.sql`
        SELECT
          c.id,
          c."updatedAt",
          ${failureReceiveCountSql} AS "failureReceiveCount",
          ${failureOccurredAtSql} AS "failureOccurredAt"
        FROM "Claim" c
        WHERE ${whereSql}
        ORDER BY ${buildErrorClaimOrderBySql(input.sort, input.direction)}
        LIMIT ${input.limit + 1}
      `,
    ),
    prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS count
      FROM "Claim" c
      WHERE ${baseWhereSql}
    `),
  ]);

  const hasMoreInDirection = orderedClaimRows.length > input.limit;
  const pageSlice = hasMoreInDirection ? orderedClaimRows.slice(0, input.limit) : orderedClaimRows;
  const orderedRows = input.direction === "prev" ? [...pageSlice].reverse() : pageSlice;
  return buildErrorClaimsResult({
    claims: await loadErrorClaimsByRowOrder(orderedRows),
    orderedRows,
    totalCount: totalCountRows[0]?.count ?? 0,
    hasMoreInDirection,
    direction: input.direction,
    sort: input.sort,
    cursor: input.cursor,
  });
}

async function listErrorClaimsWithoutRetryabilityFilter(input: {
  organizationId: string;
  filters: ClaimFilters;
  retryability: ErrorClaimRetryabilityFilter | null;
  failureDisposition: ErrorClaimFailureDispositionFilter | null;
  sort: ErrorClaimSort;
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
  const timestampCursor =
    input.cursor?.kind === "updated"
      ? { timestamp: input.cursor.timestamp, id: input.cursor.id }
      : null;
  const where = applyTimestampCursor(baseWhere, timestampCursor, input.direction, "updatedAt");

  const [claimsWindow, totalCount] = await Promise.all([
    prisma.claim.findMany({
      where,
      orderBy: input.direction === "prev" ? errorClaimsOrderByAsc : errorClaimsOrderByDesc,
      take: input.limit + 1,
      select: errorClaimSelect,
    }),
    prisma.claim.count({
      where: baseWhere,
    }),
  ]);

  const hasMoreInDirection = claimsWindow.length > input.limit;
  const pageSlice = hasMoreInDirection ? claimsWindow.slice(0, input.limit) : claimsWindow;
  const claims = input.direction === "prev" ? [...pageSlice].reverse() : pageSlice;

  return buildErrorClaimsResult({
    claims: claims.map(mapErrorClaimRecord),
    orderedRows: claims.map((claim) => ({
      id: claim.id,
      updatedAt: claim.updatedAt,
      failureReceiveCount: claim.latestWorkerFailureReceiveCount ?? -1,
      failureOccurredAt: claim.latestWorkerFailureAt ?? claim.updatedAt,
    })),
    totalCount,
    hasMoreInDirection,
    direction: input.direction,
    sort: "updated_desc",
    cursor: input.cursor,
  });
}

export function parseErrorClaimsCursor(
  value: string | null,
  sort: ErrorClaimSort,
): ErrorClaimsCursor | null {
  if (!value) {
    return null;
  }

  if (sort === "receive_count_desc") {
    return parseReceiveCountErrorClaimsCursor(value);
  }

  if (sort === "failure_oldest_first") {
    return parseFailureOldestErrorClaimsCursor(value);
  }

  return parseUpdatedErrorClaimsCursor(value);
}

export function parseErrorClaimsPageDirection(value: string | null): ErrorClaimsPageDirection {
  return parsePageDirection(value);
}

export function parseErrorClaimSort(value: string | null): ErrorClaimSort {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "receive_count_desc" || normalized === "failure_oldest_first") {
    return normalized;
  }

  return "updated_desc";
}

export function parseErrorClaimRetryabilityFilter(
  value: string | null,
): ErrorClaimRetryabilityFilter | null {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "retryable" ||
    normalized === "non_retryable" ||
    normalized === "unknown"
  ) {
    return normalized;
  }

  return null;
}

export function parseErrorClaimFailureDispositionFilter(
  value: string | null,
): ErrorClaimFailureDispositionFilter | null {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "retrying" ||
    normalized === "moved_to_dlq" ||
    normalized === "dropped_non_retryable" ||
    normalized === "unknown"
  ) {
    return normalized;
  }

  return null;
}

const errorClaimSelect = {
  id: true,
  externalClaimId: true,
  sourceEmail: true,
  customerName: true,
  productName: true,
  status: true,
  warrantyStatus: true,
  processingAttempt: true,
  latestWorkerFailureAt: true,
  latestWorkerFailureReason: true,
  latestWorkerFailureRetryable: true,
  latestWorkerFailureReceiveCount: true,
  latestWorkerFailureDisposition: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ClaimSelect;
const failureReceiveCountSql = Prisma.sql`COALESCE(c."latestWorkerFailureReceiveCount", -1)`;

const failureOccurredAtSql = Prisma.sql`COALESCE(c."latestWorkerFailureAt", c."updatedAt")`;

function buildErrorClaimWhereSql(input: {
  organizationId: string;
  filters: ClaimFilters;
  retryability: ErrorClaimRetryabilityFilter | null;
  failureDisposition: ErrorClaimFailureDispositionFilter | null;
}): Prisma.Sql {
  const clauses: Prisma.Sql[] = [
    Prisma.sql`c."organizationId" = ${input.organizationId}`,
    Prisma.sql`c.status = 'ERROR'`,
  ];

  if (input.filters.createdFrom) {
    clauses.push(Prisma.sql`c."createdAt" >= ${input.filters.createdFrom}`);
  }

  if (input.filters.createdTo) {
    clauses.push(
      Prisma.sql`c."createdAt" < ${new Date(input.filters.createdTo.getTime() + 24 * 60 * 60 * 1000)}`,
    );
  }

  if (input.filters.search) {
    const pattern = `%${escapeLikePattern(input.filters.search)}%`;
    clauses.push(Prisma.sql`
      (
        c."externalClaimId" ILIKE ${pattern} ESCAPE '\\'
        OR c."customerName" ILIKE ${pattern} ESCAPE '\\'
        OR c."productName" ILIKE ${pattern} ESCAPE '\\'
        OR c."issueSummary" ILIKE ${pattern} ESCAPE '\\'
        OR c."sourceEmail" ILIKE ${pattern} ESCAPE '\\'
      )
    `);
  }

  const retryabilityClause = buildRetryabilityWhereSql(input.retryability);
  if (retryabilityClause) {
    clauses.push(retryabilityClause);
  }

  const failureDispositionClause = buildFailureDispositionWhereSql(input.failureDisposition);
  if (failureDispositionClause) {
    clauses.push(failureDispositionClause);
  }

  return Prisma.sql`${Prisma.join(clauses, " AND ")}`;
}

function buildRetryabilityWhereSql(
  retryability: ErrorClaimRetryabilityFilter | null,
): Prisma.Sql | null {
  switch (retryability) {
    case "retryable":
      return Prisma.sql`c."latestWorkerFailureRetryable" = TRUE`;
    case "non_retryable":
      return Prisma.sql`c."latestWorkerFailureRetryable" = FALSE`;
    case "unknown":
      return Prisma.sql`c."latestWorkerFailureRetryable" IS NULL`;
    default:
      return null;
  }
}

function buildFailureDispositionWhereSql(
  failureDisposition: ErrorClaimFailureDispositionFilter | null,
): Prisma.Sql | null {
  switch (failureDisposition) {
    case "retrying":
      return Prisma.sql`c."latestWorkerFailureDisposition" = 'retrying'`;
    case "moved_to_dlq":
      return Prisma.sql`c."latestWorkerFailureDisposition" = 'moved_to_dlq'`;
    case "dropped_non_retryable":
      return Prisma.sql`c."latestWorkerFailureDisposition" = 'dropped_non_retryable'`;
    case "unknown":
      return Prisma.sql`(
        c."latestWorkerFailureDisposition" IS NULL
        OR c."latestWorkerFailureDisposition" NOT IN (
          'retrying',
          'moved_to_dlq',
          'dropped_non_retryable'
        )
      )`;
    default:
      return null;
  }
}

function buildErrorClaimCursorWhereSql(
  sort: ErrorClaimSort,
  cursor: ErrorClaimsCursor | null,
  direction: ErrorClaimsPageDirection,
): Prisma.Sql | null {
  if (!cursor) {
    return null;
  }

  if (sort === "receive_count_desc") {
    if (cursor.kind !== "receive_count_desc") {
      return null;
    }

    if (direction === "prev") {
      return Prisma.sql`(
        ${failureReceiveCountSql} > ${cursor.receiveCount}
        OR (
          ${failureReceiveCountSql} = ${cursor.receiveCount}
          AND (
            c."updatedAt" > ${timestampLiteralSql(cursor.timestamp)}
            OR (
              c."updatedAt" = ${timestampLiteralSql(cursor.timestamp)}
              AND c.id > ${cursor.id}
            )
          )
        )
      )`;
    }

    return Prisma.sql`(
      ${failureReceiveCountSql} < ${cursor.receiveCount}
      OR (
        ${failureReceiveCountSql} = ${cursor.receiveCount}
        AND (
          c."updatedAt" < ${timestampLiteralSql(cursor.timestamp)}
          OR (
            c."updatedAt" = ${timestampLiteralSql(cursor.timestamp)}
            AND c.id < ${cursor.id}
          )
        )
      )
    )`;
  }

  if (sort === "failure_oldest_first") {
    if (cursor.kind !== "failure_oldest_first") {
      return null;
    }

    if (direction === "prev") {
      return Prisma.sql`(
        ${failureOccurredAtSql} < ${timestampLiteralSql(cursor.occurredAt)}
        OR (
          ${failureOccurredAtSql} = ${timestampLiteralSql(cursor.occurredAt)}
          AND c.id < ${cursor.id}
        )
      )`;
    }

    return Prisma.sql`(
      ${failureOccurredAtSql} > ${timestampLiteralSql(cursor.occurredAt)}
      OR (
        ${failureOccurredAtSql} = ${timestampLiteralSql(cursor.occurredAt)}
        AND c.id > ${cursor.id}
      )
    )`;
  }

  if (cursor.kind !== "updated") {
    return null;
  }

  if (direction === "prev") {
    return Prisma.sql`(
      c."updatedAt" > ${cursor.timestamp}
      OR (c."updatedAt" = ${cursor.timestamp} AND c.id > ${cursor.id})
    )`;
  }

  return Prisma.sql`(
    c."updatedAt" < ${cursor.timestamp}
    OR (c."updatedAt" = ${cursor.timestamp} AND c.id < ${cursor.id})
  )`;
}

function buildErrorClaimOrderBySql(
  sort: ErrorClaimSort,
  direction: ErrorClaimsPageDirection,
): Prisma.Sql {
  if (sort === "receive_count_desc") {
    return direction === "prev"
      ? Prisma.sql`${failureReceiveCountSql} ASC, c."updatedAt" ASC, c.id ASC`
      : Prisma.sql`${failureReceiveCountSql} DESC, c."updatedAt" DESC, c.id DESC`;
  }

  if (sort === "failure_oldest_first") {
    return direction === "prev"
      ? Prisma.sql`${failureOccurredAtSql} DESC, c.id DESC`
      : Prisma.sql`${failureOccurredAtSql} ASC, c.id ASC`;
  }

  return direction === "prev"
    ? Prisma.sql`c."updatedAt" ASC, c.id ASC`
    : Prisma.sql`c."updatedAt" DESC, c.id DESC`;
}

async function loadErrorClaimsByRowOrder(
  orderedRows: Array<{ id: string }>,
): Promise<
  Array<
    Prisma.ClaimGetPayload<{
      select: typeof errorClaimSelect;
    }>
  >
> {
  const pageIds = orderedRows.map((row) => row.id);
  const claimsById =
    pageIds.length === 0
      ? new Map<string, Prisma.ClaimGetPayload<{ select: typeof errorClaimSelect }>>()
      : new Map(
          (
            await prisma.claim.findMany({
              where: {
                id: {
                  in: pageIds,
                },
              },
              select: errorClaimSelect,
            })
          ).map((claim) => [claim.id, claim]),
        );

  return orderedRows
    .map((row) => claimsById.get(row.id) ?? null)
    .filter(
      (
        claim,
      ): claim is Prisma.ClaimGetPayload<{
        select: typeof errorClaimSelect;
      }> => claim !== null,
    );
}

function mapErrorClaimRecord(
  claim: Prisma.ClaimGetPayload<{
    select: typeof errorClaimSelect;
  }>,
): ErrorClaimRecord {
  const failure = readWorkerFailureSnapshot(claim);

  return {
    id: claim.id,
    externalClaimId: claim.externalClaimId,
    sourceEmail: claim.sourceEmail,
    customerName: claim.customerName,
    productName: claim.productName,
    status: claim.status,
    warrantyStatus: claim.warrantyStatus,
    processingAttempt: claim.processingAttempt,
    createdAt: claim.createdAt.toISOString(),
    updatedAt: claim.updatedAt.toISOString(),
    failure: failure ?? null,
  };
}

function buildErrorClaimsResult(input: {
  claims: Array<
    | ErrorClaimRecord
    | Prisma.ClaimGetPayload<{
        select: typeof errorClaimSelect;
      }>
  >;
  orderedRows: ErrorClaimRow[];
  totalCount: number;
  hasMoreInDirection: boolean;
  direction: ErrorClaimsPageDirection;
  sort: ErrorClaimSort;
  cursor: ErrorClaimsCursor | null;
}) {
  const mapped =
    input.claims.length === 0 || "failure" in input.claims[0]
      ? (input.claims as ErrorClaimRecord[])
      : (input.claims as Array<
          Prisma.ClaimGetPayload<{
            select: typeof errorClaimSelect;
          }>
        >).map(mapErrorClaimRecord);

  const first = input.orderedRows[0] ?? null;
  const last = input.orderedRows[input.orderedRows.length - 1] ?? null;

  const nextCursor = last
    ? input.direction === "prev"
      ? encodeErrorClaimsCursor(last, input.sort)
      : input.hasMoreInDirection
        ? encodeErrorClaimsCursor(last, input.sort)
        : null
    : null;

  const prevCursor = first
    ? input.direction === "prev"
      ? input.hasMoreInDirection
        ? encodeErrorClaimsCursor(first, input.sort)
        : null
      : input.cursor
        ? encodeErrorClaimsCursor(first, input.sort)
        : null
    : null;

  return {
    claims: mapped,
    totalCount: input.totalCount,
    nextCursor,
    prevCursor,
  };
}

function parseUpdatedErrorClaimsCursor(value: string): UpdatedErrorClaimsCursor | null {
  const parts = value.split("~");
  const [prefix, timestampRaw, idRaw] =
    parts.length === 3 && parts[0] === "u" ? parts : [null, parts[0], parts[1]];
  void prefix;

  if (!timestampRaw || !idRaw) {
    return null;
  }

  const timestamp = new Date(timestampRaw);
  if (Number.isNaN(timestamp.getTime())) {
    return null;
  }

  const id = idRaw.trim();
  if (!id) {
    return null;
  }

  return { kind: "updated", timestamp, id };
}

function parseReceiveCountErrorClaimsCursor(value: string): ReceiveCountErrorClaimsCursor | null {
  const [prefix, receiveCountRaw, timestampRaw, idRaw] = value.split("~");
  if (prefix !== "r" || !receiveCountRaw || !timestampRaw || !idRaw) {
    return null;
  }

  const receiveCount = Number.parseInt(receiveCountRaw, 10);
  if (!Number.isInteger(receiveCount)) {
    return null;
  }

  const timestamp = new Date(timestampRaw);
  if (Number.isNaN(timestamp.getTime())) {
    return null;
  }

  const id = idRaw.trim();
  if (!id) {
    return null;
  }

  return {
    kind: "receive_count_desc",
    receiveCount,
    timestamp,
    id,
  };
}

function parseFailureOldestErrorClaimsCursor(value: string): FailureOldestErrorClaimsCursor | null {
  const [prefix, occurredAtRaw, idRaw] = value.split("~");
  if (prefix !== "f" || !occurredAtRaw || !idRaw) {
    return null;
  }

  const occurredAt = new Date(occurredAtRaw);
  if (Number.isNaN(occurredAt.getTime())) {
    return null;
  }

  const id = idRaw.trim();
  if (!id) {
    return null;
  }

  return {
    kind: "failure_oldest_first",
    occurredAt,
    id,
  };
}

function encodeUpdatedErrorClaimsCursor(cursor: {
  timestamp: Date;
  id: string;
}): string {
  return `u~${cursor.timestamp.toISOString()}~${cursor.id}`;
}

function encodeReceiveCountErrorClaimsCursor(cursor: {
  receiveCount: number;
  timestamp: Date;
  id: string;
}): string {
  return `r~${cursor.receiveCount}~${cursor.timestamp.toISOString()}~${cursor.id}`;
}

function encodeFailureOldestErrorClaimsCursor(cursor: {
  occurredAt: Date;
  id: string;
}): string {
  return `f~${cursor.occurredAt.toISOString()}~${cursor.id}`;
}

function encodeErrorClaimsCursor(
  row: ErrorClaimRow,
  sort: ErrorClaimSort,
): string {
  if (sort === "receive_count_desc") {
    return encodeReceiveCountErrorClaimsCursor({
      receiveCount: row.failureReceiveCount,
      timestamp: row.updatedAt,
      id: row.id,
    });
  }

  if (sort === "failure_oldest_first") {
    return encodeFailureOldestErrorClaimsCursor({
      occurredAt: row.failureOccurredAt,
      id: row.id,
    });
  }

  return encodeUpdatedErrorClaimsCursor({
    timestamp: row.updatedAt,
    id: row.id,
  });
}

function timestampLiteralSql(value: Date): Prisma.Sql {
  return Prisma.sql`${value.toISOString()}::timestamp`;
}

function escapeLikePattern(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
