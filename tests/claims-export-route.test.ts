import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaimsExportHandler } from "../apps/web/lib/claims/export-route.ts";

const AUTH = {
  userId: "user-export-test",
  organizationId: "org-export-test",
  role: "ANALYST" as const,
};

test("claims export rejects unauthenticated requests", async () => {
  const handler = createClaimsExportHandler({
    getAuthContextFn: async () => null,
  });

  const response = await handler(new Request("http://localhost/api/claims/export?format=json"));

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
});

test("claims export rejects invalid formats", async () => {
  const handler = createClaimsExportHandler({
    getAuthContextFn: async () => AUTH,
  });

  const response = await handler(new Request("http://localhost/api/claims/export?format=xml"));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Invalid format. Use format=csv or format=json.",
  });
});

test("claims export streams JSON attachments with clamped limits and serialized filters", async () => {
  const fetchCalls: Array<{ where: unknown; cursor: unknown; take: number }> = [];
  const streamCalls: Array<{
    where: unknown;
    limit: number;
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
    initialBatch: unknown[];
  }> = [];
  const loggedInfo: Array<{ event: string; context: Record<string, unknown> }> = [];
  const auditCalls: Array<Record<string, unknown>> = [];
  const claims = [
    {
      id: "claim-1",
      externalClaimId: "ext-1",
      sourceEmail: "customer@example.com",
      customerName: "Ada Lovelace",
      productName: "Blender",
      serialNumber: "SN-1",
      purchaseDate: new Date("2026-02-14T00:00:00.000Z"),
      issueSummary: "Stopped spinning",
      retailer: "Target",
      status: "READY",
      warrantyStatus: "LIKELY_IN_WARRANTY",
      missingInfo: [],
      createdAt: new Date("2026-03-01T10:00:00.000Z"),
      updatedAt: new Date("2026-03-02T11:00:00.000Z"),
    },
  ];
  const handler = createClaimsExportHandler({
    getAuthContextFn: async () => AUTH,
    fetchClaimExportBatchFn: async (input) => {
      fetchCalls.push(input);
      return claims;
    },
    buildJsonStreamFn: (input) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamCalls.push({
            where: input.where,
            limit: input.limit,
            metadata: input.metadata,
            initialBatch: input.initialBatch,
          });
          input.onComplete?.(input.initialBatch.length);
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                exportedAt: input.metadata.exportedAt,
                format: input.metadata.format,
                filters: input.metadata.filters,
                claims: input.initialBatch,
                count: input.initialBatch.length,
              }),
            ),
          );
          controller.close();
        },
      }),
    buildTimestampTokenFn: () => "2026-03-05T12-00-00-000Z",
    recordAuditEventFn: async (input) => {
      auditCalls.push(input);
    },
    logInfoFn: (event, context) => {
      loggedInfo.push({ event, context });
    },
  });

  const response = await handler(
    new Request(
      "http://localhost/api/claims/export?format=json&limit=99999&status=READY&search=blender&created_from=2026-02-01&created_to=2026-02-28",
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="claims-export-2026-03-05T12-00-00-000Z.json"',
  );
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");

  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.format, "json");
  assert.equal(body.count, 1);
  assert.deepEqual(body.filters, {
    status: "READY",
    search: "blender",
    createdFrom: "2026-02-01",
    createdTo: "2026-02-28",
  });
  assert.deepEqual(body.claims, [
    {
      id: "claim-1",
      externalClaimId: "ext-1",
      sourceEmail: "customer@example.com",
      customerName: "Ada Lovelace",
      productName: "Blender",
      serialNumber: "SN-1",
      purchaseDate: "2026-02-14T00:00:00.000Z",
      issueSummary: "Stopped spinning",
      retailer: "Target",
      status: "READY",
      warrantyStatus: "LIKELY_IN_WARRANTY",
      missingInfo: [],
      createdAt: "2026-03-01T10:00:00.000Z",
      updatedAt: "2026-03-02T11:00:00.000Z",
    },
  ]);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0]?.take, 250);
  assert.equal(streamCalls.length, 1);
  assert.equal(streamCalls[0]?.limit, 5000);
  assert.deepEqual(streamCalls[0]?.metadata.filters, {
    status: "READY",
    search: "blender",
    createdFrom: "2026-02-01",
    createdTo: "2026-02-28",
  });
  assert.equal(loggedInfo.length, 1);
  assert.equal(loggedInfo[0]?.event, "claims_export_completed");
  assert.deepEqual(auditCalls, [
    {
      organizationId: AUTH.organizationId,
      actorUserId: AUTH.userId,
      eventType: "CLAIM_EXPORT",
      payload: {
        format: "json",
        limit: 5000,
        filters: {
          status: "READY",
          search: "blender",
          createdFrom: "2026-02-01",
          createdTo: "2026-02-28",
        },
      },
    },
  ]);
});

test("claims export streams JSON results across batches without materializing the full export", async () => {
  const loggedInfo: Array<{ event: string; context: Record<string, unknown> }> = [];
  const fetchCalls: Array<{ cursor: unknown; take: number }> = [];
  const streamedClaims = Array.from({ length: 251 }, (_, index) => buildClaimRecord(index + 1));
  const handler = createClaimsExportHandler({
    getAuthContextFn: async () => AUTH,
    fetchClaimExportBatchFn: async (input) => {
      fetchCalls.push({
        cursor: input.cursor,
        take: input.take,
      });

      if (fetchCalls.length === 1) {
        return streamedClaims.slice(0, 250);
      }

      if (fetchCalls.length === 2) {
        return streamedClaims.slice(250);
      }

      return [];
    },
    buildTimestampTokenFn: () => "2026-03-05T12-00-00-000Z",
    recordAuditEventFn: async () => {},
    logInfoFn: (event, context) => {
      loggedInfo.push({ event, context });
    },
  });

  const response = await handler(
    new Request("http://localhost/api/claims/export?format=json&limit=251"),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");

  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.format, "json");
  assert.equal(body.count, 251);
  assert.deepEqual(body.filters, {
    status: null,
    search: null,
    createdFrom: null,
    createdTo: null,
  });
  assert.equal(Array.isArray(body.claims), true);
  assert.equal((body.claims as unknown[]).length, 251);
  assert.equal((body.claims as Array<Record<string, unknown>>)[0]?.id, "claim-1");
  assert.equal((body.claims as Array<Record<string, unknown>>)[250]?.id, "claim-251");
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0]?.take, 250);
  assert.equal(fetchCalls[1]?.take, 1);
  assert.deepEqual(
    loggedInfo.map((entry) => entry.event),
    ["claims_export_completed"],
  );
  assert.equal(loggedInfo[0]?.context.count, 251);
  assert.equal(loggedInfo[0]?.context.countPrecomputed, false);
});

test("claims export defaults to CSV and streams the response body", async () => {
  const loggedInfo: Array<{ event: string; context: Record<string, unknown> }> = [];
  const fetchCalls: Array<{ cursor: unknown; take: number }> = [];
  const handler = createClaimsExportHandler({
    getAuthContextFn: async () => AUTH,
    fetchClaimExportBatchFn: async (input) => {
      fetchCalls.push({
        cursor: input.cursor,
        take: input.take,
      });
      return [];
    },
    buildCsvStreamFn: ({ limit, initialBatch, onComplete }) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          assert.deepEqual(initialBatch, []);
          onComplete?.(1);
          controller.enqueue(new TextEncoder().encode(`header-${limit}\nrow-1\n`));
          controller.close();
        },
      }),
    buildTimestampTokenFn: () => "2026-03-05T12-00-00-000Z",
    recordAuditEventFn: async () => {},
    logInfoFn: (event, context) => {
      loggedInfo.push({ event, context });
    },
  });

  const response = await handler(new Request("http://localhost/api/claims/export?limit=25"));

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="claims-export-2026-03-05T12-00-00-000Z.csv"',
  );
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(await response.text(), "header-25\nrow-1\n");
  assert.deepEqual(fetchCalls, [{ cursor: null, take: 25 }]);
  assert.deepEqual(
    loggedInfo.map((entry) => entry.event),
    ["claims_export_completed"],
  );
  assert.equal(loggedInfo[0]?.context.count, 1);
});

test("claims export logs CSV stream failures after the response is created", async () => {
  const capturedErrors: Array<{ error: unknown; context: Record<string, unknown> }> = [];
  const loggedErrors: Array<{ event: string; context: Record<string, unknown> }> = [];
  const handler = createClaimsExportHandler({
    getAuthContextFn: async () => AUTH,
    fetchClaimExportBatchFn: async () => [],
    recordAuditEventFn: async () => {},
    buildCsvStreamFn: ({ onError }) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          const error = new Error("simulated csv stream failure");
          onError?.(error);
          controller.error(error);
        },
      }),
    captureWebExceptionFn: (error, context) => {
      capturedErrors.push({ error, context });
    },
    logErrorFn: (event, context) => {
      loggedErrors.push({ event, context });
    },
  });

  const response = await handler(new Request("http://localhost/api/claims/export"));

  await assert.rejects(() => response.text(), /simulated csv stream failure/);
  assert.equal(capturedErrors.length, 1);
  assert.equal(loggedErrors.length, 1);
  assert.equal(loggedErrors[0]?.event, "claims_export_stream_failed");
  assert.equal(loggedErrors[0]?.context.error, "simulated csv stream failure");
});

test("claims export returns 500 when export generation fails", async () => {
  const capturedErrors: Array<{ error: unknown; context: Record<string, unknown> }> = [];
  const loggedErrors: Array<{ event: string; context: Record<string, unknown> }> = [];
  const handler = createClaimsExportHandler({
    getAuthContextFn: async () => AUTH,
    fetchClaimExportBatchFn: async () => {
      throw new Error("simulated export failure");
    },
    recordAuditEventFn: async () => {},
    captureWebExceptionFn: (error, context) => {
      capturedErrors.push({ error, context });
    },
    logErrorFn: (event, context) => {
      loggedErrors.push({ event, context });
    },
  });

  const response = await handler(new Request("http://localhost/api/claims/export?format=json"));

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Unable to export claims" });
  assert.equal(capturedErrors.length, 1);
  assert.equal(loggedErrors.length, 1);
  assert.equal(loggedErrors[0]?.event, "claims_export_failed");
  assert.equal(loggedErrors[0]?.context.error, "simulated export failure");
});

function buildClaimRecord(index: number) {
  const id = `claim-${index}`;
  return {
    id,
    externalClaimId: `ext-${index}`,
    sourceEmail: `customer-${index}@example.com`,
    customerName: `Customer ${index}`,
    productName: `Product ${index}`,
    serialNumber: `SN-${index}`,
    purchaseDate: new Date("2026-02-14T00:00:00.000Z"),
    issueSummary: `Issue ${index}`,
    retailer: "Target",
    status: "READY",
    warrantyStatus: "LIKELY_IN_WARRANTY",
    missingInfo: [],
    createdAt: new Date(`2026-03-${String(((index - 1) % 28) + 1).padStart(2, "0")}T10:00:00.000Z`),
    updatedAt: new Date(`2026-03-${String(((index - 1) % 28) + 1).padStart(2, "0")}T11:00:00.000Z`),
  } as const;
}
