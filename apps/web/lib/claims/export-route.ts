import { prisma } from "@claimflow/db";
import type { Prisma } from "@prisma/client";
import { getAuthContext, hasMinimumRole } from "@/lib/auth/server";
import {
  buildClaimWhereInput,
  clampLimit,
  formatDateInput,
  parseClaimFiltersFromUrlSearchParams,
} from "@/lib/claims/filters";
import { captureWebException } from "@/lib/observability/sentry";
import { extractErrorMessage, logError, logInfo } from "@/lib/observability/log";

const CLAIM_EXPORT_BATCH_SIZE = 250;
const CSV_STREAM_CHUNK_ROWS = 64;
const JSON_STREAM_CHUNK_ROWS = 32;

const claimExportSelect = {
  id: true,
  externalClaimId: true,
  sourceEmail: true,
  customerName: true,
  productName: true,
  serialNumber: true,
  purchaseDate: true,
  issueSummary: true,
  retailer: true,
  status: true,
  warrantyStatus: true,
  missingInfo: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ClaimSelect;

const claimExportOrderBy: Prisma.ClaimOrderByWithRelationInput[] = [
  { createdAt: "desc" },
  { id: "desc" },
];

type ExportClaimRecord = Prisma.ClaimGetPayload<{ select: typeof claimExportSelect }>;
type ExportCursor = {
  createdAt: Date;
  id: string;
};

type ClaimsExportDependencies = {
  getAuthContextFn?: typeof getAuthContext;
  fetchClaimExportBatchFn?: typeof fetchClaimExportBatch;
  buildJsonStreamFn?: typeof buildJsonStream;
  buildCsvStreamFn?: typeof buildCsvStream;
  captureWebExceptionFn?: typeof captureWebException;
  logInfoFn?: typeof logInfo;
  logErrorFn?: typeof logError;
  buildTimestampTokenFn?: () => string;
};

export function createClaimsExportHandler(dependencies: ClaimsExportDependencies = {}) {
  const getAuthContextFn = dependencies.getAuthContextFn ?? getAuthContext;
  const fetchClaimExportBatchFn = dependencies.fetchClaimExportBatchFn ?? fetchClaimExportBatch;
  const buildJsonStreamFn = dependencies.buildJsonStreamFn ?? buildJsonStream;
  const buildCsvStreamFn = dependencies.buildCsvStreamFn ?? buildCsvStream;
  const captureWebExceptionFn = dependencies.captureWebExceptionFn ?? captureWebException;
  const logInfoFn = dependencies.logInfoFn ?? logInfo;
  const logErrorFn = dependencies.logErrorFn ?? logError;
  const buildTimestampTokenFn = dependencies.buildTimestampTokenFn ?? buildTimestampToken;

  return async function GET(request: Request): Promise<Response> {
    const auth = await getAuthContextFn();
    if (!auth) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!hasMinimumRole(auth.role, "VIEWER")) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    try {
      const searchParams = new URL(request.url).searchParams;
      const filters = parseClaimFiltersFromUrlSearchParams(searchParams);
      const limit = clampLimit(searchParams.get("limit"), 1000, 1, 5000);
      const formatRaw = searchParams.get("format")?.trim().toLowerCase() ?? "csv";
      const format = formatRaw === "json" ? "json" : formatRaw === "csv" ? "csv" : null;

      if (!format) {
        return Response.json(
          { error: "Invalid format. Use format=csv or format=json." },
          { status: 400 },
        );
      }

      const where = buildClaimWhereInput(auth.organizationId, filters);

      if (format === "json") {
        const initialBatch = await fetchClaimExportBatchFn({
          where,
          cursor: null,
          take: Math.min(CLAIM_EXPORT_BATCH_SIZE, limit),
        });
        const exportedAt = new Date().toISOString();
        const initialCursor =
          initialBatch.length > 0 ? getNextExportCursor(initialBatch[initialBatch.length - 1]) : null;

        return new Response(
          buildJsonStreamFn({
            where,
            limit,
            initialBatch,
            cursor: initialCursor,
            metadata: {
              exportedAt,
              format,
              filters: {
                status: filters.status,
                search: filters.search,
                createdFrom: formatDateInput(filters.createdFrom) || null,
                createdTo: formatDateInput(filters.createdTo) || null,
              },
            },
            fetchClaimExportBatchFn,
            onComplete: (count) => {
              logInfoFn("claims_export_completed", {
                organizationId: auth.organizationId,
                userId: auth.userId,
                format,
                count,
                limit,
                status: filters.status,
                hasSearch: Boolean(filters.search),
                createdFrom: filters.createdFrom?.toISOString() ?? null,
                createdTo: filters.createdTo?.toISOString() ?? null,
                countPrecomputed: false,
              });
            },
            onError: (error) => {
              captureWebExceptionFn(error, {
                route: "/api/claims/export",
                organizationId: auth.organizationId,
                userId: auth.userId,
                format,
                stage: "json_stream",
              });

              logErrorFn("claims_export_stream_failed", {
                organizationId: auth.organizationId,
                userId: auth.userId,
                format,
                error: extractErrorMessage(error),
              });
            },
          }),
          {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="claims-export-${buildTimestampTokenFn()}.json"`,
          },
          },
        );
      }

      logInfoFn("claims_export_completed", {
        organizationId: auth.organizationId,
        userId: auth.userId,
        format,
        count: null,
        limit,
        status: filters.status,
        hasSearch: Boolean(filters.search),
        createdFrom: filters.createdFrom?.toISOString() ?? null,
        createdTo: filters.createdTo?.toISOString() ?? null,
        countPrecomputed: false,
      });

      return new Response(buildCsvStreamFn({ where, limit }), {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="claims-export-${buildTimestampTokenFn()}.csv"`,
        },
      });
    } catch (error: unknown) {
      captureWebExceptionFn(error, {
        route: "/api/claims/export",
        organizationId: auth.organizationId,
        userId: auth.userId,
      });

      logErrorFn("claims_export_failed", {
        organizationId: auth.organizationId,
        userId: auth.userId,
        error: extractErrorMessage(error),
      });

      return Response.json({ error: "Unable to export claims" }, { status: 500 });
    }
  };
}

function csvEscape(value: string | null): string {
  if (!value) {
    return "";
  }

  const escaped = value.replace(/"/g, '""');
  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function buildCsvStream(input: {
  where: Prisma.ClaimWhereInput;
  limit: number;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const header = [
    "claim_id",
    "external_claim_id",
    "source_email",
    "customer_name",
    "product_name",
    "serial_number",
    "purchase_date",
    "issue_summary",
    "retailer",
    "status",
    "warranty_status",
    "missing_info",
    "created_at",
    "updated_at",
  ].join(",");

  let started = false;
  let remaining = input.limit;
  let cursor: ExportCursor | null = null;
  let batch: ExportClaimRecord[] = [];
  let batchIndex = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        controller.enqueue(encoder.encode(`${header}\n`));
        started = true;
        return;
      }

      if (batchIndex >= batch.length && remaining > 0) {
        batch = await fetchClaimExportBatch({
          where: input.where,
          cursor,
          take: Math.min(CLAIM_EXPORT_BATCH_SIZE, remaining),
        });
        batchIndex = 0;
        if (batch.length > 0) {
          cursor = getNextExportCursor(batch[batch.length - 1]);
        }
      }

      if (remaining <= 0 || batchIndex >= batch.length) {
        controller.close();
        return;
      }

      const chunkSize = Math.min(CSV_STREAM_CHUNK_ROWS, batch.length - batchIndex, remaining);
      const lines = batch
        .slice(batchIndex, batchIndex + chunkSize)
        .map(claimToCsvRow)
        .join("\n");

      controller.enqueue(encoder.encode(`${lines}\n`));
      batchIndex += chunkSize;
      remaining -= chunkSize;
    },
  });
}

function buildJsonStream(input: {
  where: Prisma.ClaimWhereInput;
  limit: number;
  initialBatch: ExportClaimRecord[];
  cursor: ExportCursor | null;
  metadata: {
    exportedAt: string;
    format: "json";
    filters: {
      status: string | null;
      search: string | null;
      createdFrom: string | null;
      createdTo: string | null;
    };
  };
  fetchClaimExportBatchFn: typeof fetchClaimExportBatch;
  onComplete?: (count: number) => void;
  onError?: (error: unknown) => void;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const prefix = `{"exportedAt":${JSON.stringify(input.metadata.exportedAt)},"format":"json","filters":${JSON.stringify(input.metadata.filters)},"claims":[`;

  let started = false;
  let completed = false;
  let count = 0;
  let remaining = input.limit;
  let cursor = input.cursor;
  let batch = input.initialBatch;
  let batchIndex = 0;
  let emittedAnyClaim = false;
  let moreAvailable = input.initialBatch.length === Math.min(CLAIM_EXPORT_BATCH_SIZE, input.limit);

  const finalize = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (completed) {
      return;
    }

    controller.enqueue(encoder.encode(`],"count":${count}}`));
    completed = true;
    input.onComplete?.(count);
    controller.close();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          controller.enqueue(encoder.encode(prefix));
          started = true;
          if (batch.length === 0 && remaining <= 0) {
            finalize(controller);
          }
          return;
        }

        if (batchIndex >= batch.length && remaining > 0 && moreAvailable) {
          const take = Math.min(CLAIM_EXPORT_BATCH_SIZE, remaining);
          batch = await input.fetchClaimExportBatchFn({
            where: input.where,
            cursor,
            take,
          });
          batchIndex = 0;
          moreAvailable = batch.length === take;
          if (batch.length > 0) {
            cursor = getNextExportCursor(batch[batch.length - 1]);
          }
        }

        if (batchIndex >= batch.length) {
          finalize(controller);
          return;
        }

        const chunkSize = Math.min(JSON_STREAM_CHUNK_ROWS, batch.length - batchIndex, remaining);
        const chunk = batch.slice(batchIndex, batchIndex + chunkSize);
        const serialized = chunk.map((claim) => JSON.stringify(claim)).join(",");
        controller.enqueue(encoder.encode(`${emittedAnyClaim ? "," : ""}${serialized}`));
        emittedAnyClaim = true;
        batchIndex += chunkSize;
        count += chunkSize;
        remaining -= chunkSize;
      } catch (error: unknown) {
        completed = true;
        input.onError?.(error);
        controller.error(error);
      }
    },
  });
}

function claimToCsvRow(claim: ExportClaimRecord): string {
  return [
    claim.id,
    claim.externalClaimId,
    claim.sourceEmail,
    claim.customerName,
    claim.productName,
    claim.serialNumber,
    formatDateInput(claim.purchaseDate),
    claim.issueSummary,
    claim.retailer,
    claim.status,
    claim.warrantyStatus,
    claim.missingInfo.join("|"),
    claim.createdAt.toISOString(),
    claim.updatedAt.toISOString(),
  ]
    .map(csvEscape)
    .join(",");
}

async function fetchClaimExportBatch(input: {
  where: Prisma.ClaimWhereInput;
  cursor: ExportCursor | null;
  take: number;
}): Promise<ExportClaimRecord[]> {
  return prisma.claim.findMany({
    where: applyExportCursor(input.where, input.cursor),
    orderBy: claimExportOrderBy,
    take: input.take,
    select: claimExportSelect,
  });
}

function applyExportCursor(
  where: Prisma.ClaimWhereInput,
  cursor: ExportCursor | null,
): Prisma.ClaimWhereInput {
  if (!cursor) {
    return where;
  }

  return {
    AND: [
      where,
      {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          {
            AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }],
          },
        ],
      },
    ],
  };
}

function getNextExportCursor(claim: ExportClaimRecord): ExportCursor {
  return {
    createdAt: claim.createdAt,
    id: claim.id,
  };
}

function buildTimestampToken(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
