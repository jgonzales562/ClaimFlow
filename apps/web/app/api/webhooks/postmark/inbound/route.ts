import { prisma } from "@claimflow/db";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  getPostmarkAttachments,
  getMailboxHash,
  isPostmarkInboundPayload,
  type NormalizedPostmarkAttachment,
  parsePostmarkAddress,
  parseReceivedAt,
  type PostmarkInboundPayload,
} from "@/lib/postmark/inbound";
import { enqueueClaimIngestJob, type ClaimQueueEnqueueResult } from "@/lib/queue/claims";
import { putAttachmentObject } from "@/lib/storage/s3";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!isPostmarkInboundPayload(payload)) {
    return NextResponse.json({ error: "Invalid Postmark payload" }, { status: 422 });
  }

  const mailboxHash = getMailboxHash(payload);
  const organization = await resolveOrganization(mailboxHash);
  if (!organization) {
    return NextResponse.json(
      { error: "Unable to resolve organization for inbound message" },
      { status: 422 },
    );
  }

  const providerMessageId = payload.MessageID.trim();
  const attachments = getPostmarkAttachments(payload);

  const existingMessage = await prisma.inboundMessage.findUnique({
    where: {
      organizationId_provider_providerMessageId: {
        organizationId: organization.id,
        provider: "POSTMARK",
        providerMessageId,
      },
    },
    select: {
      id: true,
      claimId: true,
      createdAt: true,
      claim: {
        select: {
          status: true,
        },
      },
    },
  });

  if (existingMessage) {
    const queueResult = await maybeEnqueueClaimForProcessing({
      organizationId: organization.id,
      claimId: existingMessage.claimId,
      inboundMessageId: existingMessage.id,
      providerMessageId,
      shouldEnqueue: existingMessage.claim?.status === "NEW",
    });

    if (queueResult && !queueResult.enqueued && queueResult.reason === "send_failed") {
      console.error("Failed to enqueue deduplicated claim ingest job", {
        organizationId: organization.id,
        claimId: existingMessage.claimId,
        messageId: existingMessage.id,
        providerMessageId,
        queueUrl: queueResult.queueUrl,
        error: queueResult.error,
      });

      return NextResponse.json(
        { error: "Unable to enqueue claim for processing" },
        { status: 500 },
      );
    }

    return NextResponse.json({
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

  const { email: fromEmail, name: fromName } = parsePostmarkAddress(payload.From);
  const { email: toEmail } = parsePostmarkAddress(payload.To);

  try {
    const created = await prisma.$transaction(async (tx) => {
      const claim = await tx.claim.create({
        data: {
          organizationId: organization.id,
          externalClaimId: `postmark:${providerMessageId}`,
          sourceEmail: fromEmail ?? payload.From ?? null,
          issueSummary: payload.TextBody ?? payload.StrippedTextReply ?? payload.Subject ?? null,
          status: "NEW",
        },
        select: {
          id: true,
          status: true,
        },
      });

      const inboundMessage = await tx.inboundMessage.create({
        data: {
          organizationId: organization.id,
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
          claimId: claim.id,
        },
        select: {
          id: true,
        },
      });

      return {
        claimId: claim.id,
        claimStatus: claim.status,
        messageId: inboundMessage.id,
      };
    });

    const attachmentResult = await persistAttachments({
      organizationId: organization.id,
      claimId: created.claimId,
      inboundMessageId: created.messageId,
      providerMessageId,
      attachments,
    });

    const queueResult = await maybeEnqueueClaimForProcessing({
      organizationId: organization.id,
      claimId: created.claimId,
      inboundMessageId: created.messageId,
      providerMessageId,
      shouldEnqueue: true,
    });

    if (queueResult && !queueResult.enqueued && queueResult.reason === "send_failed") {
      console.error("Failed to enqueue claim ingest job", {
        organizationId: organization.id,
        claimId: created.claimId,
        messageId: created.messageId,
        providerMessageId,
        queueUrl: queueResult.queueUrl,
        error: queueResult.error,
      });

      return NextResponse.json(
        { error: "Unable to enqueue claim for processing" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      deduplicated: false,
      organizationId: organization.id,
      claimId: created.claimId,
      claimStatus: queueResult?.enqueued ? "PROCESSING" : created.claimStatus,
      messageId: created.messageId,
      attachments: attachmentResult,
      queue: queueResult,
    });
  } catch (error: unknown) {
    // If another request inserted the same provider message in parallel, treat as deduplicated.
    if (isUniqueConstraintError(error)) {
      const deduplicated = await prisma.inboundMessage.findUnique({
        where: {
          organizationId_provider_providerMessageId: {
            organizationId: organization.id,
            provider: "POSTMARK",
            providerMessageId,
          },
        },
        select: {
          id: true,
          claimId: true,
          createdAt: true,
          claim: {
            select: {
              status: true,
            },
          },
        },
      });

      if (deduplicated) {
        const queueResult = await maybeEnqueueClaimForProcessing({
          organizationId: organization.id,
          claimId: deduplicated.claimId,
          inboundMessageId: deduplicated.id,
          providerMessageId,
          shouldEnqueue: deduplicated.claim?.status === "NEW",
        });

        if (queueResult && !queueResult.enqueued && queueResult.reason === "send_failed") {
          console.error("Failed to enqueue deduplicated claim ingest job", {
            organizationId: organization.id,
            claimId: deduplicated.claimId,
            messageId: deduplicated.id,
            providerMessageId,
            queueUrl: queueResult.queueUrl,
            error: queueResult.error,
          });

          return NextResponse.json(
            { error: "Unable to enqueue claim for processing" },
            { status: 500 },
          );
        }

        return NextResponse.json({
          ok: true,
          deduplicated: true,
          messageId: deduplicated.id,
          claimId: deduplicated.claimId,
          receivedAt: deduplicated.createdAt.toISOString(),
          claimStatus:
            queueResult?.enqueued === true ? "PROCESSING" : (deduplicated.claim?.status ?? null),
          queue: queueResult,
        });
      }
    }

    console.error("Failed to process Postmark inbound webhook", error);
    return NextResponse.json({ error: "Unable to process inbound message" }, { status: 500 });
  }
}

function isAuthorizedRequest(request: NextRequest): boolean {
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

async function resolveOrganization(mailboxHash: string | null) {
  if (mailboxHash) {
    const mailbox = await prisma.integrationMailbox.findUnique({
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

  return prisma.organization.findUnique({
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

async function maybeEnqueueClaimForProcessing(input: {
  organizationId: string;
  claimId: string | null;
  inboundMessageId: string;
  providerMessageId: string;
  shouldEnqueue: boolean;
}): Promise<ClaimQueueEnqueueResult | null> {
  if (!input.claimId || !input.shouldEnqueue) {
    return null;
  }

  const queueResult = await enqueueClaimIngestJob({
    claimId: input.claimId,
    organizationId: input.organizationId,
    inboundMessageId: input.inboundMessageId,
    providerMessageId: input.providerMessageId,
  });

  if (queueResult.enqueued) {
    await prisma.claim.update({
      where: { id: input.claimId },
      data: { status: "PROCESSING" },
    });
  }

  return queueResult;
}

async function persistAttachments(input: {
  organizationId: string;
  claimId: string;
  inboundMessageId: string;
  providerMessageId: string;
  attachments: NormalizedPostmarkAttachment[];
}) {
  if (input.attachments.length === 0) {
    return {
      received: 0,
      stored: 0,
      failed: 0,
      errors: [] as Array<{ filename: string; message: string }>,
    };
  }

  const errors: Array<{ filename: string; message: string }> = [];
  let stored = 0;

  for (const attachment of input.attachments) {
    const attachmentId = randomUUID();
    const safeFilename = sanitizeFilename(attachment.originalFilename);
    const fileBuffer = decodeBase64(attachment.base64Content);

    if (!fileBuffer) {
      await createFailedAttachmentRecord({
        organizationId: input.organizationId,
        claimId: input.claimId,
        inboundMessageId: input.inboundMessageId,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
        errorMessage: "Attachment content is not valid base64.",
      });
      errors.push({
        filename: attachment.originalFilename,
        message: "Attachment content is not valid base64.",
      });
      continue;
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
      const storedObject = await putAttachmentObject({
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

      await prisma.claimAttachment.create({
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

      stored += 1;
    } catch (error: unknown) {
      const message = extractErrorMessage(error);
      await createFailedAttachmentRecord({
        organizationId: input.organizationId,
        claimId: input.claimId,
        inboundMessageId: input.inboundMessageId,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: fileBuffer.length,
        errorMessage: message,
      });

      errors.push({
        filename: attachment.originalFilename,
        message,
      });
    }
  }

  return {
    received: input.attachments.length,
    stored,
    failed: errors.length,
    errors,
  };
}

async function createFailedAttachmentRecord(input: {
  organizationId: string;
  claimId: string;
  inboundMessageId: string;
  originalFilename: string;
  contentType: string | null;
  byteSize: number;
  errorMessage: string;
}) {
  await prisma.claimAttachment.create({
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

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Unknown upload error.";
}
