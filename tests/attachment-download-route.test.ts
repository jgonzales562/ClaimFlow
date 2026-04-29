import assert from "node:assert/strict";
import { test } from "node:test";
import { createAttachmentDownloadHandler } from "../apps/web/lib/claims/attachment-download-route.ts";

const AUTH = {
  userId: "user-attachment-test",
  organizationId: "org-attachment-test",
  role: "ANALYST" as const,
};

const STORED_ATTACHMENT = {
  uploadStatus: "STORED" as const,
  originalFilename: "receipt.pdf",
  contentType: "application/pdf",
  s3Bucket: "attachments-bucket",
  s3Key: "claims/claim-1/receipt.pdf",
};

test("attachment download rejects unauthenticated requests", async () => {
  const handler = createAttachmentDownloadHandler({
    getAuthContextFn: async () => null,
  });

  const response = await handler(
    new Request("http://localhost/api/claims/claim-1/attachments/attachment-1/download"),
    { claimId: "claim-1", attachmentId: "attachment-1" },
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
});

test("attachment download rejects users below viewer role", async () => {
  const handler = createAttachmentDownloadHandler({
    getAuthContextFn: async () => ({ ...AUTH, role: "VIEWER" }),
    hasMinimumRoleFn: () => false,
  });

  const response = await handler(
    new Request("http://localhost/api/claims/claim-1/attachments/attachment-1/download"),
    { claimId: "claim-1", attachmentId: "attachment-1" },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Forbidden" });
});

test("attachment download returns 404 when the attachment is not found", async () => {
  const handler = createAttachmentDownloadHandler({
    getAuthContextFn: async () => AUTH,
    findAttachmentFn: async () => null,
  });

  const response = await handler(
    new Request("http://localhost/api/claims/claim-1/attachments/missing/download"),
    { claimId: "claim-1", attachmentId: "missing" },
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Attachment not found" });
});

test("attachment download returns 409 when the attachment is not stored", async () => {
  const handler = createAttachmentDownloadHandler({
    getAuthContextFn: async () => AUTH,
    findAttachmentFn: async () => ({
      ...STORED_ATTACHMENT,
      uploadStatus: "FAILED" as const,
    }),
  });

  const response = await handler(
    new Request("http://localhost/api/claims/claim-1/attachments/attachment-1/download"),
    { claimId: "claim-1", attachmentId: "attachment-1" },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Attachment is not available for download",
  });
});

test("attachment download returns 409 when inline preview is requested for unsupported content", async () => {
  const handler = createAttachmentDownloadHandler({
    getAuthContextFn: async () => AUTH,
    findAttachmentFn: async () => ({
      ...STORED_ATTACHMENT,
      contentType: "text/plain",
      originalFilename: "notes.txt",
    }),
  });

  const response = await handler(
    new Request(
      "http://localhost/api/claims/claim-1/attachments/attachment-1/download?disposition=inline",
    ),
    { claimId: "claim-1", attachmentId: "attachment-1" },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Attachment content type cannot be previewed inline",
  });
});

test("attachment download redirects to a signed URL on success", async () => {
  const signedUrlCalls: Array<Record<string, unknown>> = [];
  const auditCalls: Array<Record<string, unknown>> = [];
  const handler = createAttachmentDownloadHandler({
    getAuthContextFn: async () => AUTH,
    findAttachmentFn: async () => STORED_ATTACHMENT,
    recordAuditEventFn: async (input) => {
      auditCalls.push(input);
    },
    createSignedAttachmentAccessUrlFn: async (input) => {
      signedUrlCalls.push(input);
      return "https://signed.example.test/download";
    },
    getSignedUrlTtlSecondsFn: () => 900,
  });

  const response = await handler(
    new Request(
      "http://localhost/api/claims/claim-1/attachments/attachment-1/download?disposition=inline",
    ),
    { claimId: "claim-1", attachmentId: "attachment-1" },
  );

  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "https://signed.example.test/download");
  assert.deepEqual(signedUrlCalls, [
    {
      bucket: "attachments-bucket",
      key: "claims/claim-1/receipt.pdf",
      filename: "receipt.pdf",
      contentType: "application/pdf",
      expiresInSeconds: 900,
      disposition: "inline",
    },
  ]);
  assert.deepEqual(auditCalls, [
    {
      organizationId: AUTH.organizationId,
      actorUserId: AUTH.userId,
      eventType: "ATTACHMENT_ACCESS",
      payload: {
        claimId: "claim-1",
        attachmentId: "attachment-1",
        disposition: "inline",
        contentType: "application/pdf",
        originalFilename: "receipt.pdf",
      },
    },
  ]);
});

test("attachment download returns 500 and logs when signed URL generation fails", async () => {
  const capturedErrors: Array<{ error: unknown; context: Record<string, unknown> }> = [];
  const loggedErrors: Array<{ event: string; context: Record<string, unknown> }> = [];
  const handler = createAttachmentDownloadHandler({
    getAuthContextFn: async () => AUTH,
    findAttachmentFn: async () => STORED_ATTACHMENT,
    recordAuditEventFn: async () => {},
    createSignedAttachmentAccessUrlFn: async () => {
      throw new Error("simulated signer failure");
    },
    captureWebExceptionFn: (error, context) => {
      capturedErrors.push({ error, context });
    },
    logErrorFn: (event, context) => {
      loggedErrors.push({ event, context });
    },
  });

  const response = await handler(
    new Request("http://localhost/api/claims/claim-1/attachments/attachment-1/download"),
    { claimId: "claim-1", attachmentId: "attachment-1" },
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Unable to prepare attachment download" });
  assert.equal(capturedErrors.length, 1);
  assert.equal(loggedErrors.length, 1);
  assert.equal(loggedErrors[0]?.event, "claim_attachment_download_url_failed");
  assert.equal(loggedErrors[0]?.context.error, "simulated signer failure");
});
