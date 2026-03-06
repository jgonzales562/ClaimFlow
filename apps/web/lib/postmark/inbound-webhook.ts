import { prisma } from "@claimflow/db";
import type { Prisma } from "@prisma/client";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import {
  getPostmarkAttachments,
  getMailboxHash,
  isPostmarkInboundPayload,
  type NormalizedPostmarkAttachment,
  parsePostmarkAddress,
  parseReceivedAt,
  type PostmarkInboundPayload,
} from "@/lib/postmark/inbound";
import { maybeEnqueueClaimForProcessing } from "@/lib/claims/ingest";
import { extractErrorMessage, logError } from "@/lib/observability/log";
import { captureWebException } from "@/lib/observability/sentry";
import { putAttachmentObject } from "@/lib/storage/s3";

const ATTACHMENT_PERSIST_CONCURRENCY = parseIntegerEnv(
  "POSTMARK_ATTACHMENT_PERSIST_CONCURRENCY",
  3,
  1,
  10,
);

const existingInboundMessageSelect = {
  id: true,
  claimId: true,
  createdAt: true,
  claim: {
    select: {
      status: true,
    },
  },
} as const satisfies Prisma.InboundMessageSelect;

type PostmarkInboundRouteDependencies = {
  prismaClient?: typeof prisma;
  maybeEnqueueClaimForProcessingFn?: typeof maybeEnqueueClaimForProcessing;
  putAttachmentObjectFn?: typeof putAttachmentObject;
  captureWebExceptionFn?: typeof captureWebException;
  logErrorFn?: typeof logError;
};

export function createPostmarkInboundHandler(
  dependencies: PostmarkInboundRouteDependencies = {},
): (request: Request) => Promise<Response> {
  const prismaClient = dependencies.prismaClient ?? prisma;
  const maybeEnqueueClaimForProcessingFn =
    dependencies.maybeEnqueueClaimForProcessingFn ?? maybeEnqueueClaimForProcessing;
  const putAttachmentObjectFn = dependencies.putAttachmentObjectFn ?? putAttachmentObject;
  const captureWebExceptionFn = dependencies.captureWebExceptionFn ?? captureWebException;
  const logErrorFn = dependencies.logErrorFn ?? logError;

  return async function handlePostmarkInboundRequest(request: Request): Promise<Response> {
    if (!isAuthorizedRequest(request)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (!isPostmarkInboundPayload(payload)) {
      return Response.json({ error: "Invalid Postmark payload" }, { status: 422 });
    }

    const mailboxHash = getMailboxHash(payload);
    const organization = await resolveOrganization(mailboxHash, prismaClient);
    if (!organization) {
      return Response.json(
        { error: "Unable to resolve organization for inbound message" },
        { status: 422 },
      );
    }

    const providerMessageId = payload.MessageID.trim();
    const attachments = getPostmarkAttachments(payload);

    const { email: fromEmail, name: fromName } = parsePostmarkAddress(payload.From);
    const { email: toEmail } = parsePostmarkAddress(payload.To);

    try {
      const created = await prismaClient.inboundMessage.create({
        data: {
          organization: {
            connect: {
              id: organization.id,
            },
          },
          provider: "POSTMARK",
          providerMessageId,
          mailboxHash,
          fromEmail,
          fromName,
          toEmail,
          subject: payload.Subject ?? null,
          textBody: payload.TextBody ?? null,
          htmlBody: payload.HtmlBody ?? null,
          strippedTextReply: payload.StrippedTextReply ?? null,
          receivedAt: parseReceivedAt(payload.Date),
          rawPayload: payload as PostmarkInboundPayload,
          claim: {
            create: {
              organization: {
                connect: {
                  id: organization.id,
                },
              },
              externalClaimId: `postmark:${providerMessageId}`,
              sourceEmail: fromEmail ?? payload.From ?? null,
              issueSummary:
                payload.TextBody ?? payload.StrippedTextReply ?? payload.Subject ?? null,
              status: "NEW",
            },
          },
        },
        select: {
          id: true,
          claimId: true,
        },
      });

      if (!created.claimId) {
        throw new Error("Inbound message claim relation was not created.");
      }

      const attachmentResult = await persistAttachments(
        {
          organizationId: organization.id,
          claimId: created.claimId,
          inboundMessageId: created.id,
          providerMessageId,
          attachments,
        },
        {
          prismaClient,
          putAttachmentObjectFn,
        },
      );

      const queueResult = await maybeEnqueueClaimForProcessingFn({
        organizationId: organization.id,
        claimId: created.claimId,
        inboundMessageId: created.id,
        providerMessageId,
        shouldEnqueue: true,
      });

      if (queueResult && !queueResult.enqueued && queueResult.reason === "send_failed") {
        return respondToEnqueueFailure(
          {
            event: "webhook_enqueue_claim_failed",
            organizationId: organization.id,
            claimId: created.claimId,
            messageId: created.id,
            providerMessageId,
            queueUrl: queueResult.queueUrl,
            error: queueResult.error,
          },
          logErrorFn,
        );
      }

      return Response.json({
        ok: true,
        deduplicated: false,
        organizationId: organization.id,
        claimId: created.claimId,
        claimStatus: queueResult?.enqueued ? "PROCESSING" : "NEW",
        messageId: created.id,
        attachments: attachmentResult,
        queue: queueResult,
      });
    } catch (error: unknown) {
      // If another request inserted the same provider message in parallel, treat as deduplicated.
      if (isUniqueConstraintError(error)) {
        const deduplicated = await prismaClient.inboundMessage.findUnique({
          where: {
            organizationId_provider_providerMessageId: {
              organizationId: organization.id,
              provider: "POSTMARK",
              providerMessageId,
            },
          },
          select: existingInboundMessageSelect,
        });

        if (deduplicated) {
          return respondForExistingInboundMessage(
            {
              organizationId: organization.id,
              providerMessageId,
              existingMessage: deduplicated,
            },
            {
              maybeEnqueueClaimForProcessingFn,
              logErrorFn,
            },
          );
        }
      }

      captureWebExceptionFn(error, {
        route: "/api/webhooks/postmark/inbound",
        organizationId: organization.id,
        providerMessageId,
      });

      logErrorFn("webhook_process_failed", {
        organizationId: organization.id,
        providerMessageId,
        error: extractErrorMessage(error, "Unknown upload error."),
      });

      return Response.json({ error: "Unable to process inbound message" }, { status: 500 });
    }
  };
}

const defaultPostmarkInboundHandler = createPostmarkInboundHandler();

export async function POST(request: Request): Promise<Response> {
  return defaultPostmarkInboundHandler(request);
}

function isAuthorizedRequest(request: Request): boolean {
  const expectedUser = process.env.POSTMARK_WEBHOOK_BASIC_AUTH_USER?.trim();
  const expectedPass = process.env.POSTMARK_WEBHOOK_BASIC_AUTH_PASS?.trim();

  if (!expectedUser && !expectedPass) {
    return true;
  }

  const headerValue = request.headers.get("authorization");
  if (!headerValue || !headerValue.startsWith("Basic ")) {
    return false;
  }

  const encoded = headerValue.slice("Basic ".length);
  let decoded = "";
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return false;
  }

  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) {
    return false;
  }

  const providedUser = decoded.slice(0, separatorIndex);
  const providedPass = decoded.slice(separatorIndex + 1);

  return (
    secureCompare(providedUser, expectedUser ?? "") &&
    secureCompare(providedPass, expectedPass ?? "")
  );
}

async function resolveOrganization(mailboxHash: string | null, prismaClient: typeof prisma) {
  if (mailboxHash) {
    const mailbox = await prismaClient.integrationMailbox.findUnique({
      where: {
        provider_mailboxHash: {
          provider: "POSTMARK",
          mailboxHash,
        },
      },
      select: {
        organization: {
          select: {
            id: true,
          },
        },
      },
    });

    if (mailbox) {
      return mailbox.organization;
    }
  }

  const fallbackSlug = process.env.POSTMARK_DEFAULT_ORG_SLUG?.trim();
  if (!fallbackSlug) {
    return null;
  }

  return prismaClient.organization.findUnique({
    where: { slug: fallbackSlug },
    select: { id: true },
  });
}

function isUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return (error as { code?: string }).code === "P2002";
}

function secureCompare(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

type ExistingInboundMessageRecord = Prisma.InboundMessageGetPayload<{
  select: typeof existingInboundMessageSelect;
}>;

async function respondForExistingInboundMessage(input: {
  organizationId: string;
  providerMessageId: string;
  existingMessage: ExistingInboundMessageRecord;
}, dependencies: {
  maybeEnqueueClaimForProcessingFn: typeof maybeEnqueueClaimForProcessing;
  logErrorFn: typeof logError;
}): Promise<Response> {
  const { organizationId, providerMessageId, existingMessage } = input;
  const queueResult = await dependencies.maybeEnqueueClaimForProcessingFn({
    organizationId,
    claimId: existingMessage.claimId,
    inboundMessageId: existingMessage.id,
    providerMessageId,
    shouldEnqueue: existingMessage.claim?.status === "NEW",
  });

  if (queueResult && !queueResult.enqueued && queueResult.reason === "send_failed") {
    return respondToEnqueueFailure(
      {
        event: "webhook_enqueue_deduplicated_failed",
        organizationId,
        claimId: existingMessage.claimId,
        messageId: existingMessage.id,
        providerMessageId,
        queueUrl: queueResult.queueUrl,
        error: queueResult.error,
      },
      dependencies.logErrorFn,
    );
  }

  return Response.json({
    ok: true,
    deduplicated: true,
    messageId: existingMessage.id,
    claimId: existingMessage.claimId,
    receivedAt: existingMessage.createdAt.toISOString(),
    claimStatus:
      queueResult?.enqueued === true ? "PROCESSING" : (existingMessage.claim?.status ?? null),
    queue: queueResult,
  });
}

function respondToEnqueueFailure(input: {
  event: "webhook_enqueue_claim_failed" | "webhook_enqueue_deduplicated_failed";
  organizationId: string;
  claimId: string | null;
  messageId: string;
  providerMessageId: string;
  queueUrl: string | undefined;
  error: string | undefined;
}, logErrorFn: typeof logError): Response {
  logErrorFn(input.event, {
    organizationId: input.organizationId,
    claimId: input.claimId,
    messageId: input.messageId,
    providerMessageId: input.providerMessageId,
    queueUrl: input.queueUrl,
    error: input.error,
  });

  return Response.json({ error: "Unable to enqueue claim for processing" }, { status: 500 });
}

async function persistAttachments(input: {
  organizationId: string;
  claimId: string;
  inboundMessageId: string;
  providerMessageId: string;
  attachments: NormalizedPostmarkAttachment[];
}, dependencies: {
  prismaClient: typeof prisma;
  putAttachmentObjectFn: typeof putAttachmentObject;
}) {
  if (input.attachments.length === 0) {
    return {
      received: 0,
      stored: 0,
      failed: 0,
      errors: [] as Array<{ filename: string; message: string }>,
    };
  }

  const results = await mapWithConcurrency(
    input.attachments,
    ATTACHMENT_PERSIST_CONCURRENCY,
    async (attachment) =>
      persistSingleAttachment({
        organizationId: input.organizationId,
        claimId: input.claimId,
        inboundMessageId: input.inboundMessageId,
        providerMessageId: input.providerMessageId,
        attachment,
      }, dependencies),
  );

  let stored = 0;
  const errors: Array<{ filename: string; message: string }> = [];
  for (const result of results) {
    if (result.stored) {
      stored += 1;
      continue;
    }
    errors.push(result.error);
  }

  return {
    received: input.attachments.length,
    stored,
    failed: errors.length,
    errors,
  };
}

async function persistSingleAttachment(input: {
  organizationId: string;
  claimId: string;
  inboundMessageId: string;
  providerMessageId: string;
  attachment: NormalizedPostmarkAttachment;
}, dependencies: {
  prismaClient: typeof prisma;
  putAttachmentObjectFn: typeof putAttachmentObject;
}): Promise<
  { stored: true } | { stored: false; error: { filename: string; message: string } }
> {
  const attachment = input.attachment;
  const attachmentId = randomUUID();
  const safeFilename = sanitizeFilename(attachment.originalFilename);
  const fileBuffer = decodeBase64(attachment.base64Content);

  if (!fileBuffer) {
    const message = "Attachment content is not valid base64.";
    await createFailedAttachmentRecord(
      {
        organizationId: input.organizationId,
        claimId: input.claimId,
        inboundMessageId: input.inboundMessageId,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
        errorMessage: message,
      },
      dependencies.prismaClient,
    );
    return {
      stored: false,
      error: {
        filename: attachment.originalFilename,
        message,
      },
    };
  }

  const s3Key = buildAttachmentS3Key({
    organizationId: input.organizationId,
    claimId: input.claimId,
    inboundMessageId: input.inboundMessageId,
    attachmentId,
    filename: safeFilename,
  });

  const checksumSha256 = createHash("sha256").update(fileBuffer).digest("hex");

  try {
    const storedObject = await dependencies.putAttachmentObjectFn({
      key: s3Key,
      body: fileBuffer,
      contentType: attachment.contentType,
      metadata: {
        claim_id: input.claimId,
        inbound_message_id: input.inboundMessageId,
        provider_message_id: input.providerMessageId,
        attachment_id: attachmentId,
        original_filename: attachment.originalFilename,
      },
    });

    await dependencies.prismaClient.claimAttachment.create({
      data: {
        organizationId: input.organizationId,
        claimId: input.claimId,
        inboundMessageId: input.inboundMessageId,
        uploadStatus: "STORED",
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: fileBuffer.length,
        checksumSha256,
        s3Bucket: storedObject.bucket,
        s3Key: storedObject.key,
      },
    });

    return { stored: true };
  } catch (error: unknown) {
    const message = extractErrorMessage(error, "Unknown upload error.");
    await createFailedAttachmentRecord(
      {
        organizationId: input.organizationId,
        claimId: input.claimId,
        inboundMessageId: input.inboundMessageId,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: fileBuffer.length,
        errorMessage: message,
      },
      dependencies.prismaClient,
    );

    return {
      stored: false,
      error: {
        filename: attachment.originalFilename,
        message,
      },
    };
  }
}

async function mapWithConcurrency<TInput, TResult>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  if (items.length === 0) {
    return [];
  }

  const safeConcurrency = Math.max(1, Math.floor(concurrency));
  const workerCount = Math.min(safeConcurrency, items.length);
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      if (currentIndex >= items.length) {
        return;
      }
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

async function createFailedAttachmentRecord(input: {
  organizationId: string;
  claimId: string;
  inboundMessageId: string;
  originalFilename: string;
  contentType: string | null;
  byteSize: number;
  errorMessage: string;
}, prismaClient: typeof prisma) {
  await prismaClient.claimAttachment.create({
    data: {
      organizationId: input.organizationId,
      claimId: input.claimId,
      inboundMessageId: input.inboundMessageId,
      uploadStatus: "FAILED",
      originalFilename: input.originalFilename,
      contentType: input.contentType,
      byteSize: input.byteSize,
      s3Bucket: "unavailable",
      s3Key: "unavailable",
      errorMessage: input.errorMessage.slice(0, 2048),
    },
  });
}

function buildAttachmentS3Key(input: {
  organizationId: string;
  claimId: string;
  inboundMessageId: string;
  attachmentId: string;
  filename: string;
}): string {
  return [
    "orgs",
    input.organizationId,
    "claims",
    input.claimId,
    "messages",
    input.inboundMessageId,
    `${input.attachmentId}-${input.filename}`,
  ].join("/");
}

function sanitizeFilename(value: string): string {
  const basename = path.basename(value);
  const sanitized = basename.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    return "attachment.bin";
  }
  return sanitized.slice(0, 180);
}

function decodeBase64(value: string): Buffer | null {
  try {
    const buffer = Buffer.from(value, "base64");
    if (!buffer.length && value.length > 0) {
      return null;
    }
    return buffer;
  } catch {
    return null;
  }
}

function parseIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }

  return parsed;
}
