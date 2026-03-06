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

test("claims export returns JSON attachments with clamped limits and serialized filters", async () => {
  const calls: Array<{ where: unknown; limit: number }> = [];
  const loggedInfo: Array<{ event: string; context: Record<string, unknown> }> = [];
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
    listClaimsForExportFn: async (input) => {
      calls.push(input);
      return claims;
    },
    buildTimestampTokenFn: () => "2026-03-05T12-00-00-000Z",
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
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.limit, 5000);
  assert.equal(loggedInfo.length, 1);
  assert.equal(loggedInfo[0]?.event, "claims_export_completed");
});

test("claims export defaults to CSV and streams the response body", async () => {
  const loggedInfo: Array<{ event: string; context: Record<string, unknown> }> = [];
  const handler = createClaimsExportHandler({
    getAuthContextFn: async () => AUTH,
    buildCsvStreamFn: ({ limit }) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`header-${limit}\nrow-1\n`));
          controller.close();
        },
      }),
    buildTimestampTokenFn: () => "2026-03-05T12-00-00-000Z",
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
  assert.deepEqual(loggedInfo.map((entry) => entry.event), ["claims_export_completed"]);
});

test("claims export returns 500 when export generation fails", async () => {
  const capturedErrors: Array<{ error: unknown; context: Record<string, unknown> }> = [];
  const loggedErrors: Array<{ event: string; context: Record<string, unknown> }> = [];
  const handler = createClaimsExportHandler({
    getAuthContextFn: async () => AUTH,
    listClaimsForExportFn: async () => {
      throw new Error("simulated export failure");
    },
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
