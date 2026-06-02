import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import {
  ExtractionSettingsValidationError,
  MAX_SCAN_KEYWORDS,
  parseScanKeywordsText,
  updateOrganizationExtractionSettings,
} from "../apps/web/lib/extraction/settings.ts";
import { prisma } from "../packages/db/src/index.ts";

after(async () => {
  await prisma.$disconnect();
});

test("scan keyword parser normalizes comma and newline input", () => {
  assert.deepEqual(
    parseScanKeywordsText(" compressor failure,Proof of Purchase\nproof of purchase\n serial   number "),
    ["compressor failure", "Proof of Purchase", "serial number"],
  );
});

test("scan keyword parser rejects unsafe bounds", () => {
  assert.throws(
    () => parseScanKeywordsText("x".repeat(81)),
    (error: unknown) =>
      error instanceof ExtractionSettingsValidationError && error.code === "keyword_too_long",
  );

  assert.throws(
    () =>
      parseScanKeywordsText(
        Array.from({ length: MAX_SCAN_KEYWORDS + 1 }, (_, index) => `keyword-${index}`).join("\n"),
      ),
    (error: unknown) =>
      error instanceof ExtractionSettingsValidationError && error.code === "too_many_keywords",
  );
});

test("organization extraction settings persist keywords and audit updates", async () => {
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: {
      name: `Extraction Settings ${suffix}`,
      slug: `extraction-settings-${suffix}`,
    },
    select: {
      id: true,
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `extraction-settings-${suffix}@example.com`,
    },
    select: {
      id: true,
    },
  });

  try {
    const result = await updateOrganizationExtractionSettings(
      {
        organizationId: organization.id,
        actorUserId: user.id,
        scanKeywordsText: "compressor failure\nproof of purchase",
      },
      {
        prismaClient: prisma,
      },
    );

    assert.deepEqual(result, {
      kind: "updated",
      scanKeywords: ["compressor failure", "proof of purchase"],
    });

    const settings = await prisma.organizationExtractionSettings.findUniqueOrThrow({
      where: {
        organizationId: organization.id,
      },
      select: {
        scanKeywords: true,
      },
    });
    assert.deepEqual(settings.scanKeywords, ["compressor failure", "proof of purchase"]);

    const noChange = await updateOrganizationExtractionSettings(
      {
        organizationId: organization.id,
        actorUserId: user.id,
        scanKeywordsText: "compressor failure\nproof of purchase",
      },
      {
        prismaClient: prisma,
      },
    );
    assert.equal(noChange.kind, "no_changes");

    const auditEvents = await prisma.auditEvent.findMany({
      where: {
        organizationId: organization.id,
        eventType: "EXTRACTION_SETTINGS_UPDATE",
      },
      select: {
        actorUserId: true,
        payload: true,
      },
    });

    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0]?.actorUserId, user.id);
    assert.deepEqual(auditEvents[0]?.payload, {
      previousScanKeywords: [],
      nextScanKeywords: ["compressor failure", "proof of purchase"],
    });
  } finally {
    await prisma.organization.delete({
      where: {
        id: organization.id,
      },
    });
    await prisma.user.delete({
      where: {
        id: user.id,
      },
    });
  }
});
