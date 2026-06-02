import { AUDIT_EVENT_PAYLOAD_SCHEMA_VERSION, prisma } from "@claimflow/db";
import type { PrismaClient } from "@prisma/client";

export const MAX_SCAN_KEYWORDS = 75;
export const MAX_SCAN_KEYWORD_LENGTH = 80;

export type OrganizationExtractionSettings = {
  organizationId: string;
  scanKeywords: string[];
  updatedAt: Date | null;
};

export type UpdateOrganizationExtractionSettingsInput = {
  organizationId: string;
  actorUserId: string;
  scanKeywordsText: string;
};

export type UpdateOrganizationExtractionSettingsResult =
  | {
      kind: "updated";
      scanKeywords: string[];
    }
  | {
      kind: "no_changes";
      scanKeywords: string[];
    };

type UpdateOrganizationExtractionSettingsDependencies = {
  prismaClient?: PrismaClient;
};

export class ExtractionSettingsValidationError extends Error {
  readonly code: "too_many_keywords" | "keyword_too_long";

  constructor(code: ExtractionSettingsValidationError["code"], message: string) {
    super(message);
    this.name = "ExtractionSettingsValidationError";
    this.code = code;
  }
}

export async function loadOrganizationExtractionSettings(
  organizationId: string,
  dependencies: { prismaClient?: PrismaClient } = {},
): Promise<OrganizationExtractionSettings> {
  const prismaClient = dependencies.prismaClient ?? prisma;
  const settings = await prismaClient.organizationExtractionSettings.findUnique({
    where: {
      organizationId,
    },
    select: {
      organizationId: true,
      scanKeywords: true,
      updatedAt: true,
    },
  });

  return {
    organizationId,
    scanKeywords: settings?.scanKeywords ?? [],
    updatedAt: settings?.updatedAt ?? null,
  };
}

export async function updateOrganizationExtractionSettings(
  input: UpdateOrganizationExtractionSettingsInput,
  dependencies: UpdateOrganizationExtractionSettingsDependencies = {},
): Promise<UpdateOrganizationExtractionSettingsResult> {
  const prismaClient = dependencies.prismaClient ?? prisma;
  const nextKeywords = parseScanKeywordsText(input.scanKeywordsText);
  const current = await loadOrganizationExtractionSettings(input.organizationId, {
    prismaClient,
  });

  if (arraysEqual(current.scanKeywords, nextKeywords)) {
    return {
      kind: "no_changes",
      scanKeywords: current.scanKeywords,
    };
  }

  await prismaClient.$transaction(async (tx) => {
    await tx.organizationExtractionSettings.upsert({
      where: {
        organizationId: input.organizationId,
      },
      update: {
        scanKeywords: nextKeywords,
      },
      create: {
        organizationId: input.organizationId,
        scanKeywords: nextKeywords,
      },
    });

    await tx.auditEvent.create({
      data: {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        eventType: "EXTRACTION_SETTINGS_UPDATE",
        payloadSchemaVersion: AUDIT_EVENT_PAYLOAD_SCHEMA_VERSION,
        payload: {
          previousScanKeywords: current.scanKeywords,
          nextScanKeywords: nextKeywords,
        },
      },
    });
  });

  return {
    kind: "updated",
    scanKeywords: nextKeywords,
  };
}

export function parseScanKeywordsText(value: string): string[] {
  const keywords = value
    .split(/[\n,]+/)
    .map(normalizeScanKeyword)
    .filter((keyword): keyword is string => Boolean(keyword));

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const keyword of keywords) {
    if (keyword.length > MAX_SCAN_KEYWORD_LENGTH) {
      throw new ExtractionSettingsValidationError(
        "keyword_too_long",
        `Scan keywords must be ${MAX_SCAN_KEYWORD_LENGTH} characters or fewer.`,
      );
    }

    const key = keyword.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(keyword);
  }

  if (deduped.length > MAX_SCAN_KEYWORDS) {
    throw new ExtractionSettingsValidationError(
      "too_many_keywords",
      `Use ${MAX_SCAN_KEYWORDS} scan keywords or fewer.`,
    );
  }

  return deduped;
}

function normalizeScanKeyword(value: string): string | null {
  const normalized = replaceControlCharacters(value).replace(/\s+/g, " ").trim();
  return normalized || null;
}

function replaceControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? " " : character;
  }).join("");
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}
