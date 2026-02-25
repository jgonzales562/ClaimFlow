import { prisma } from "@claimflow/db";
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  getMailboxHash,
  isPostmarkInboundPayload,
  parsePostmarkAddress,
  parseReceivedAt,
  type PostmarkInboundPayload,
} from "@/lib/postmark/inbound";

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
    },
  });

  if (existingMessage) {
    return NextResponse.json({
      ok: true,
      deduplicated: true,
      messageId: existingMessage.id,
      claimId: existingMessage.claimId,
      receivedAt: existingMessage.createdAt.toISOString(),
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

    return NextResponse.json({
      ok: true,
      deduplicated: false,
      organizationId: organization.id,
      claimId: created.claimId,
      claimStatus: created.claimStatus,
      messageId: created.messageId,
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
        },
      });

      if (deduplicated) {
        return NextResponse.json({
          ok: true,
          deduplicated: true,
          messageId: deduplicated.id,
          claimId: deduplicated.claimId,
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
    secureCompare(providedUser, expectedUser ?? "") && secureCompare(providedPass, expectedPass ?? "")
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
