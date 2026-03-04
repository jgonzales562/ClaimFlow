import { prisma } from "@claimflow/db";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getAuthContext, hasMinimumRole } from "@/lib/auth/server";
import { extractErrorMessage, logError } from "@/lib/observability/log";
import { captureWebException } from "@/lib/observability/sentry";
import { createSignedAttachmentAccessUrl } from "@/lib/storage/s3";

type RouteContext = {
  params: Promise<{
    claimId: string;
    attachmentId: string;
  }>;
};

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasMinimumRole(auth.role, "VIEWER")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { claimId, attachmentId } = await context.params;
  const disposition = parseRequestedDisposition(request.nextUrl.searchParams.get("disposition"));

  try {
    const attachment = await prisma.claimAttachment.findFirst({
      where: {
        id: attachmentId,
        claimId,
        organizationId: auth.organizationId,
      },
      select: {
        id: true,
        uploadStatus: true,
        originalFilename: true,
        contentType: true,
        s3Bucket: true,
        s3Key: true,
      },
    });

    if (!attachment) {
      return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
    }

    if (attachment.uploadStatus !== "STORED") {
      return NextResponse.json(
        { error: "Attachment is not available for download" },
        { status: 409 },
      );
    }

    if (disposition === "inline" && !isInlinePreviewable(attachment.contentType)) {
      return NextResponse.json(
        { error: "Attachment content type cannot be previewed inline" },
        { status: 409 },
      );
    }

    const signedUrl = await createSignedAttachmentAccessUrl({
      bucket: attachment.s3Bucket,
      key: attachment.s3Key,
      filename: attachment.originalFilename,
      contentType: attachment.contentType,
      expiresInSeconds: parseSignedUrlTtlSeconds(),
      disposition,
    });

    return NextResponse.redirect(signedUrl, { status: 307 });
  } catch (error: unknown) {
    captureWebException(error, {
      route: "/api/claims/[claimId]/attachments/[attachmentId]/download",
      organizationId: auth.organizationId,
      userId: auth.userId,
      claimId,
      attachmentId,
      disposition,
    });

    logError("claim_attachment_download_url_failed", {
      organizationId: auth.organizationId,
      userId: auth.userId,
      claimId,
      attachmentId,
      disposition,
      error: extractErrorMessage(error),
    });

    return NextResponse.json({ error: "Unable to prepare attachment download" }, { status: 500 });
  }
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

function isInlinePreviewable(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }

  const normalized = contentType.trim().toLowerCase();
  return normalized === "application/pdf" || normalized.startsWith("image/");
}
