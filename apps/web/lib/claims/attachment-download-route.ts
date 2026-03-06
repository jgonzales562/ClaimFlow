import { prisma } from "@claimflow/db";
import { getAuthContext, hasMinimumRole } from "@/lib/auth/server";
import { isInlinePreviewableAttachment } from "@/lib/attachments";
import { extractErrorMessage, logError } from "@/lib/observability/log";
import { captureWebException } from "@/lib/observability/sentry";
import { createSignedAttachmentAccessUrl } from "@/lib/storage/s3";

type AttachmentDownloadDependencies = {
  getAuthContextFn?: typeof getAuthContext;
  hasMinimumRoleFn?: typeof hasMinimumRole;
  findAttachmentFn?: (input: {
    attachmentId: string;
    claimId: string;
    organizationId: string;
  }) => Promise<{
    uploadStatus: "STORED" | "FAILED";
    originalFilename: string;
    contentType: string | null;
    s3Bucket: string;
    s3Key: string;
  } | null>;
  createSignedAttachmentAccessUrlFn?: typeof createSignedAttachmentAccessUrl;
  captureWebExceptionFn?: typeof captureWebException;
  logErrorFn?: typeof logError;
  getSignedUrlTtlSecondsFn?: () => number;
};

const ATTACHMENT_SIGNED_URL_TTL_SECONDS = parseSignedUrlTtlSeconds();

export function createAttachmentDownloadHandler(dependencies: AttachmentDownloadDependencies = {}) {
  const getAuthContextFn = dependencies.getAuthContextFn ?? getAuthContext;
  const hasMinimumRoleFn = dependencies.hasMinimumRoleFn ?? hasMinimumRole;
  const findAttachmentFn =
    dependencies.findAttachmentFn ??
    (async (input) =>
      prisma.claimAttachment.findFirst({
        where: {
          id: input.attachmentId,
          claimId: input.claimId,
          organizationId: input.organizationId,
        },
        select: {
          uploadStatus: true,
          originalFilename: true,
          contentType: true,
          s3Bucket: true,
          s3Key: true,
        },
      }));
  const createSignedAttachmentAccessUrlFn =
    dependencies.createSignedAttachmentAccessUrlFn ?? createSignedAttachmentAccessUrl;
  const captureWebExceptionFn = dependencies.captureWebExceptionFn ?? captureWebException;
  const logErrorFn = dependencies.logErrorFn ?? logError;
  const getSignedUrlTtlSecondsFn =
    dependencies.getSignedUrlTtlSecondsFn ?? (() => ATTACHMENT_SIGNED_URL_TTL_SECONDS);

  return async function GET(
    request: Request,
    params: { claimId: string; attachmentId: string },
  ): Promise<Response> {
    const auth = await getAuthContextFn();
    if (!auth) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!hasMinimumRoleFn(auth.role, "VIEWER")) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const disposition = parseRequestedDisposition(new URL(request.url).searchParams.get("disposition"));

    try {
      const attachment = await findAttachmentFn({
        attachmentId: params.attachmentId,
        claimId: params.claimId,
        organizationId: auth.organizationId,
      });

      if (!attachment) {
        return Response.json({ error: "Attachment not found" }, { status: 404 });
      }

      if (attachment.uploadStatus !== "STORED") {
        return Response.json(
          { error: "Attachment is not available for download" },
          { status: 409 },
        );
      }

      if (disposition === "inline" && !isInlinePreviewableAttachment(attachment.contentType)) {
        return Response.json(
          { error: "Attachment content type cannot be previewed inline" },
          { status: 409 },
        );
      }

      const signedUrl = await createSignedAttachmentAccessUrlFn({
        bucket: attachment.s3Bucket,
        key: attachment.s3Key,
        filename: attachment.originalFilename,
        contentType: attachment.contentType,
        expiresInSeconds: getSignedUrlTtlSecondsFn(),
        disposition,
      });

      return new Response(null, {
        status: 307,
        headers: {
          location: signedUrl,
        },
      });
    } catch (error: unknown) {
      captureWebExceptionFn(error, {
        route: "/api/claims/[claimId]/attachments/[attachmentId]/download",
        organizationId: auth.organizationId,
        userId: auth.userId,
        claimId: params.claimId,
        attachmentId: params.attachmentId,
        disposition,
      });

      logErrorFn("claim_attachment_download_url_failed", {
        organizationId: auth.organizationId,
        userId: auth.userId,
        claimId: params.claimId,
        attachmentId: params.attachmentId,
        disposition,
        error: extractErrorMessage(error),
      });

      return Response.json({ error: "Unable to prepare attachment download" }, { status: 500 });
    }
  };
}

function parseSignedUrlTtlSeconds(): number {
  const raw = process.env.ATTACHMENTS_SIGNED_URL_TTL_SECONDS?.trim();
  if (!raw) {
    return 300;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return 300;
  }

  return Math.min(Math.max(parsed, 60), 3600);
}

function parseRequestedDisposition(value: string | null): "attachment" | "inline" {
  if (!value) {
    return "attachment";
  }

  return value.trim().toLowerCase() === "inline" ? "inline" : "attachment";
}
