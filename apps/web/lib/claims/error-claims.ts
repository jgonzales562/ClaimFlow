import { prisma } from "@claimflow/db";
import { Prisma } from "@prisma/client";
import { parsePageDirection, type PageDirection } from "./cursor-pagination";
import { normalizeExactEmailSearchTerm, type ClaimFilters } from "./filters";
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
export const ERROR_CLAIM_RETRYABILITY_FILTERS = ["retryable", "non_retryable", "unknown"] as const;
export type ErrorClaimRetryabilityFilter = (typeof ERROR_CLAIM_RETRYABILITY_FILTERS)[number];
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
type ErrorClaimPageRow = ErrorClaimRow & {
  totalCount: number;
  externalClaimId: string | null;
  sourceEmail: string | null;
  customerName: string | null;
  productName: string | null;
  status: string;
  warrantyStatus: string;
  processingAttempt: number;
  latestWorkerFailureAt: Date | null;
  latestWorkerFailureReason: string | null;
  latestWorkerFailureRetryable: boolean | null;
  latestWorkerFailureReceiveCount: number | null;
  latestWorkerFailureDisposition: string | null;
  createdAt: Date;
};

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
    "filtered",
  );
  const orderedClaimRows = await prisma.$queryRaw<Array<ErrorClaimPageRow>>(
    Prisma.sql`
      WITH filtered AS (
        SELECT
          c.id,
          c."externalClaimId",
          c."sourceEmail",
          c."customerName",
          c."productName",
          c.status,
          c."warrantyStatus",
          c."processingAttempt",
          c."latestWorkerFailureAt",
          c."latestWorkerFailureReason",
          c."latestWorkerFailureRetryable",
          c."latestWorkerFailureReceiveCount",
          c."latestWorkerFailureDisposition",
          c."createdAt",
          c."updatedAt",
          ${failureReceiveCountBaseSql} AS "failureReceiveCount",
          ${failureOccurredAtBaseSql} AS "failureOccurredAt",
          COUNT(*) OVER()::int AS "totalCount"
        FROM "Claim" c
        WHERE ${baseWhereSql}
      )
      SELECT
        f.id,
        f."updatedAt",
        f."failureReceiveCount",
        f."failureOccurredAt",
        f."externalClaimId",
        f."sourceEmail",
        f."customerName",
        f."productName",
        f.status,
        f."warrantyStatus",
        f."processingAttempt",
        f."latestWorkerFailureAt",
        f."latestWorkerFailureReason",
        f."latestWorkerFailureRetryable",
        f."latestWorkerFailureReceiveCount",
        f."latestWorkerFailureDisposition",
        f."createdAt",
        f."totalCount"
      FROM filtered f
      ${cursorWhereSql ? Prisma.sql`WHERE ${cursorWhereSql}` : Prisma.empty}
      ORDER BY ${buildErrorClaimOrderBySql(input.sort, input.direction, "filtered")}
      LIMIT ${input.limit + 1}
    `,
  );

  const hasMoreInDirection = orderedClaimRows.length > input.limit;
  const pageSlice = hasMoreInDirection ? orderedClaimRows.slice(0, input.limit) : orderedClaimRows;
  const orderedRows = input.direction === "prev" ? [...pageSlice].reverse() : pageSlice;
  const totalCount =
    orderedRows[0]?.totalCount ?? (input.cursor ? await loadErrorClaimTotalCount(baseWhereSql) : 0);
  return buildErrorClaimsResult({
    claims: orderedRows.map(mapErrorClaimPageRow),
    orderedRows,
    totalCount,
    hasMoreInDirection,
    direction: input.direction,
    sort: input.sort,
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
  if (normalized === "retryable" || normalized === "non_retryable" || normalized === "unknown") {
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

const failureReceiveCountBaseSql = Prisma.sql`COALESCE(c."latestWorkerFailureReceiveCount", -1)`;

const failureOccurredAtBaseSql = Prisma.sql`COALESCE(c."latestWorkerFailureAt", c."updatedAt")`;

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
    const exactEmailSearch = normalizeExactEmailSearchTerm(input.filters.search);
    clauses.push(
      exactEmailSearch
        ? Prisma.sql`
            (
              c."sourceEmail" = ${exactEmailSearch}
              OR c."externalClaimId" ILIKE ${pattern} ESCAPE '\\'
              OR c."customerName" ILIKE ${pattern} ESCAPE '\\'
              OR c."productName" ILIKE ${pattern} ESCAPE '\\'
              OR c."issueSummary" ILIKE ${pattern} ESCAPE '\\'
            )
          `
        : Prisma.sql`
            (
              c."externalClaimId" ILIKE ${pattern} ESCAPE '\\'
              OR c."customerName" ILIKE ${pattern} ESCAPE '\\'
              OR c."productName" ILIKE ${pattern} ESCAPE '\\'
              OR c."issueSummary" ILIKE ${pattern} ESCAPE '\\'
              OR c."sourceEmail" ILIKE ${pattern} ESCAPE '\\'
            )
          `,
    );
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
  scope: "base" | "filtered" = "base",
): Prisma.Sql | null {
  if (!cursor) {
    return null;
  }

  const updatedAtSql = scope === "filtered" ? Prisma.sql`f."updatedAt"` : Prisma.sql`c."updatedAt"`;
  const idSql = scope === "filtered" ? Prisma.sql`f.id` : Prisma.sql`c.id`;
  const failureReceiveCountSql =
    scope === "filtered" ? Prisma.sql`f."failureReceiveCount"` : failureReceiveCountBaseSql;
  const failureOccurredAtSql =
    scope === "filtered" ? Prisma.sql`f."failureOccurredAt"` : failureOccurredAtBaseSql;

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
            ${updatedAtSql} > ${timestampLiteralSql(cursor.timestamp)}
            OR (
              ${updatedAtSql} = ${timestampLiteralSql(cursor.timestamp)}
              AND ${idSql} > ${cursor.id}
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
          ${updatedAtSql} < ${timestampLiteralSql(cursor.timestamp)}
          OR (
            ${updatedAtSql} = ${timestampLiteralSql(cursor.timestamp)}
            AND ${idSql} < ${cursor.id}
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
          AND ${idSql} < ${cursor.id}
        )
      )`;
    }

    return Prisma.sql`(
      ${failureOccurredAtSql} > ${timestampLiteralSql(cursor.occurredAt)}
      OR (
        ${failureOccurredAtSql} = ${timestampLiteralSql(cursor.occurredAt)}
        AND ${idSql} > ${cursor.id}
      )
    )`;
  }

  if (cursor.kind !== "updated") {
    return null;
  }

  if (direction === "prev") {
    return Prisma.sql`(
      ${updatedAtSql} > ${timestampLiteralSql(cursor.timestamp)}
      OR (
        ${updatedAtSql} = ${timestampLiteralSql(cursor.timestamp)}
        AND ${idSql} > ${cursor.id}
      )
    )`;
  }

  return Prisma.sql`(
    ${updatedAtSql} < ${timestampLiteralSql(cursor.timestamp)}
    OR (
      ${updatedAtSql} = ${timestampLiteralSql(cursor.timestamp)}
      AND ${idSql} < ${cursor.id}
    )
  )`;
}

function buildErrorClaimOrderBySql(
  sort: ErrorClaimSort,
  direction: ErrorClaimsPageDirection,
  scope: "base" | "filtered" = "base",
): Prisma.Sql {
  const updatedAtSql = scope === "filtered" ? Prisma.sql`f."updatedAt"` : Prisma.sql`c."updatedAt"`;
  const idSql = scope === "filtered" ? Prisma.sql`f.id` : Prisma.sql`c.id`;
  const failureReceiveCountSql =
    scope === "filtered" ? Prisma.sql`f."failureReceiveCount"` : failureReceiveCountBaseSql;
  const failureOccurredAtSql =
    scope === "filtered" ? Prisma.sql`f."failureOccurredAt"` : failureOccurredAtBaseSql;

  if (sort === "receive_count_desc") {
    return direction === "prev"
      ? Prisma.sql`${failureReceiveCountSql} ASC, ${updatedAtSql} ASC, ${idSql} ASC`
      : Prisma.sql`${failureReceiveCountSql} DESC, ${updatedAtSql} DESC, ${idSql} DESC`;
  }

  if (sort === "failure_oldest_first") {
    return direction === "prev"
      ? Prisma.sql`${failureOccurredAtSql} DESC, ${idSql} DESC`
      : Prisma.sql`${failureOccurredAtSql} ASC, ${idSql} ASC`;
  }

  return direction === "prev"
    ? Prisma.sql`${updatedAtSql} ASC, ${idSql} ASC`
    : Prisma.sql`${updatedAtSql} DESC, ${idSql} DESC`;
}

function mapErrorClaimPageRow(claim: ErrorClaimPageRow): ErrorClaimRecord {
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
  claims: ErrorClaimRecord[];
  orderedRows: ErrorClaimRow[];
  totalCount: number;
  hasMoreInDirection: boolean;
  direction: ErrorClaimsPageDirection;
  sort: ErrorClaimSort;
  cursor: ErrorClaimsCursor | null;
}) {
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
    claims: input.claims,
    totalCount: input.totalCount,
    nextCursor,
    prevCursor,
  };
}

async function loadErrorClaimTotalCount(baseWhereSql: Prisma.Sql): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS count
    FROM "Claim" c
    WHERE ${baseWhereSql}
  `);

  return rows[0]?.count ?? 0;
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

function encodeUpdatedErrorClaimsCursor(cursor: { timestamp: Date; id: string }): string {
  return `u~${cursor.timestamp.toISOString()}~${cursor.id}`;
}

function encodeReceiveCountErrorClaimsCursor(cursor: {
  receiveCount: number;
  timestamp: Date;
  id: string;
}): string {
  return `r~${cursor.receiveCount}~${cursor.timestamp.toISOString()}~${cursor.id}`;
}

function encodeFailureOldestErrorClaimsCursor(cursor: { occurredAt: Date; id: string }): string {
  return `f~${cursor.occurredAt.toISOString()}~${cursor.id}`;
}

function encodeErrorClaimsCursor(row: ErrorClaimRow, sort: ErrorClaimSort): string {
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
