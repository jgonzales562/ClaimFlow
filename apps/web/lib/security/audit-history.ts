import { prisma } from "@claimflow/db";
import type { PrismaClient } from "@prisma/client";

export type OrganizationAuditEvent = {
  id: string;
  eventType: string;
  payload: unknown;
  createdAt: Date;
  actorUser: {
    email: string;
    fullName: string | null;
  } | null;
};

type AuditHistoryClient = Pick<PrismaClient, "auditEvent">;

export async function listOrganizationAuditEvents(
  input: {
    organizationId: string;
    limit?: number;
  },
  dependencies: { prismaClient?: AuditHistoryClient } = {},
): Promise<OrganizationAuditEvent[]> {
  const prismaClient = dependencies.prismaClient ?? prisma;
  return prismaClient.auditEvent.findMany({
    where: {
      organizationId: input.organizationId,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: normalizeAuditEventLimit(input.limit),
    select: {
      id: true,
      eventType: true,
      payload: true,
      createdAt: true,
      actorUser: {
        select: {
          email: true,
          fullName: true,
        },
      },
    },
  });
}

export function describeAuditEvent(eventType: string, payload: unknown): string {
  if (eventType === "CLAIM_EXPORT") {
    const format = readPayloadString(payload, "format") ?? "unknown";
    const limit = readPayloadNumber(payload, "limit");
    return limit === null
      ? `Claim export requested as ${format}.`
      : `Claim export requested as ${format} with limit ${limit}.`;
  }

  if (eventType === "ATTACHMENT_ACCESS") {
    const filename = readPayloadString(payload, "originalFilename");
    const disposition = readPayloadString(payload, "disposition") ?? "download";
    return filename
      ? `Attachment ${disposition} requested for ${filename}.`
      : `Attachment ${disposition} requested.`;
  }

  if (eventType === "EXTRACTION_SETTINGS_UPDATE") {
    const nextKeywords = readPayloadStringArray(payload, "nextScanKeywords");
    return `Extraction scan keywords updated to ${nextKeywords.length} configured term${
      nextKeywords.length === 1 ? "" : "s"
    }.`;
  }

  return "Audit event recorded.";
}

export function getAuditEventTone(eventType: string): "neutral" | "info" | "warning" {
  if (eventType === "CLAIM_EXPORT") {
    return "warning";
  }

  if (eventType === "ATTACHMENT_ACCESS") {
    return "info";
  }

  return "neutral";
}

function normalizeAuditEventLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 100;
  }

  return Math.min(Math.max(Math.floor(value), 1), 500);
}

function readPayloadString(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readPayloadNumber(payload: unknown, key: string): number | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readPayloadStringArray(payload: unknown, key: string): string[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }

  const value = (payload as Record<string, unknown>)[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}
