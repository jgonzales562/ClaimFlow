import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import { ClaimStatus, MembershipRole, PrismaClient, WarrantyStatus } from "@prisma/client";

const prisma = new PrismaClient();
const scrypt = promisify(scryptCallback);
const DEFAULT_SEED_ADMIN_EMAIL = "admin@claimflow.local";
const DEFAULT_SEED_ADMIN_FULL_NAME = "ClaimFlow Admin";

async function main(): Promise<void> {
  const seedAdmin = await resolveSeedAdminCredentials();

  const organization = await prisma.organization.upsert({
    where: { slug: "acme-warranty" },
    update: { name: "Acme Warranty Operations" },
    create: {
      name: "Acme Warranty Operations",
      slug: "acme-warranty",
    },
  });

  const adminUser = await prisma.user.upsert({
    where: { email: seedAdmin.email },
    update: {
      fullName: seedAdmin.fullName,
      passwordHash: seedAdmin.passwordHash,
    },
    create: {
      email: seedAdmin.email,
      fullName: seedAdmin.fullName,
      passwordHash: seedAdmin.passwordHash,
    },
  });

  await prisma.membership.upsert({
    where: {
      organizationId_userId: {
        organizationId: organization.id,
        userId: adminUser.id,
      },
    },
    update: { role: MembershipRole.ADMIN },
    create: {
      organizationId: organization.id,
      userId: adminUser.id,
      role: MembershipRole.ADMIN,
    },
  });

  const seedClaims = [
    {
      externalClaimId: "seed-claim-001",
      sourceEmail: "claims@dealer.example",
      customerName: "Jordan Miles",
      productName: "Acme ProCool X1200",
      serialNumber: "ACX1200-4459",
      purchaseDate: new Date("2025-01-15T00:00:00.000Z"),
      issueSummary: "Compressor failure after abnormal noise and cooling loss.",
      retailer: "North Valley HVAC Supply",
      warrantyStatus: WarrantyStatus.LIKELY_IN_WARRANTY,
      missingInfo: ["installation_receipt"],
      status: ClaimStatus.REVIEW_REQUIRED,
    },
    {
      externalClaimId: "seed-claim-002",
      sourceEmail: "claims@dealer.example",
      customerName: "Casey Dalton",
      productName: "Acme HeatCore Z500",
      serialNumber: "ACZ500-7781",
      purchaseDate: new Date("2025-02-20T00:00:00.000Z"),
      issueSummary: "Unit stops heating after five minutes of runtime.",
      retailer: "Summit Home Systems",
      warrantyStatus: WarrantyStatus.UNCLEAR,
      missingInfo: ["proof_of_purchase"],
      status: ClaimStatus.REVIEW_REQUIRED,
    },
    {
      externalClaimId: "seed-claim-003",
      sourceEmail: "claims@dealer.example",
      customerName: "Riley Chen",
      productName: "Acme AirSense S90",
      serialNumber: "ACS90-9912",
      purchaseDate: new Date("2024-11-02T00:00:00.000Z"),
      issueSummary: "Fan spins but airflow is intermittent.",
      retailer: "Pacific Climate Supply",
      warrantyStatus: WarrantyStatus.LIKELY_IN_WARRANTY,
      missingInfo: [],
      status: ClaimStatus.REVIEW_REQUIRED,
    },
    {
      externalClaimId: "seed-claim-004",
      sourceEmail: "claims@dealer.example",
      customerName: "Morgan Patel",
      productName: "Acme FlowMaster A7",
      serialNumber: "ACFA7-5540",
      purchaseDate: new Date("2024-09-12T00:00:00.000Z"),
      issueSummary: "System logs show repeated extraction failures after attachment intake.",
      retailer: "West Peak Distribution",
      warrantyStatus: WarrantyStatus.UNCLEAR,
      missingInfo: ["service_report"],
      status: ClaimStatus.ERROR,
    },
    {
      externalClaimId: "seed-claim-005",
      sourceEmail: "claims@dealer.example",
      customerName: "Taylor Brooks",
      productName: "Acme SealGuard P12",
      serialNumber: "ACSP12-1403",
      purchaseDate: new Date("2025-03-03T00:00:00.000Z"),
      issueSummary: "Installer report and proof of service are attached for review.",
      retailer: "Harbor Mechanical Supply",
      warrantyStatus: WarrantyStatus.LIKELY_IN_WARRANTY,
      missingInfo: [],
      status: ClaimStatus.REVIEW_REQUIRED,
    },
    {
      externalClaimId: "seed-claim-006",
      sourceEmail: "claims@dealer.example",
      customerName: "Avery Sutton",
      productName: "Acme RelayOne R4",
      serialNumber: "ACR4-6641",
      purchaseDate: new Date("2024-12-18T00:00:00.000Z"),
      issueSummary: "Transient extraction error after intake. Safe to retry from the triage queue.",
      retailer: "Central Systems Depot",
      warrantyStatus: WarrantyStatus.UNCLEAR,
      missingInfo: ["purchase_invoice"],
      status: ClaimStatus.ERROR,
    },
    {
      externalClaimId: "seed-claim-007",
      sourceEmail: "claims@dealer.example",
      customerName: "Jamie Flores",
      productName: "Acme ControlHub C8",
      serialNumber: "ACCH8-2120",
      purchaseDate: new Date("2025-01-08T00:00:00.000Z"),
      issueSummary: "Claim has remained in intake processing longer than expected and should surface recovery controls.",
      retailer: "Metro Climate Parts",
      warrantyStatus: WarrantyStatus.UNCLEAR,
      missingInfo: ["installer_notes"],
      status: ClaimStatus.PROCESSING,
    },
  ] as const;

  const seededClaimsByExternalId = new Map<string, { id: string }>();

  for (const claim of seedClaims) {
    const seededClaim = await prisma.claim.upsert({
      where: {
        organizationId_externalClaimId: {
          organizationId: organization.id,
          externalClaimId: claim.externalClaimId,
        },
      },
      update: claim,
      create: {
        organizationId: organization.id,
        createdByUserId: adminUser.id,
        ...claim,
      },
    });

    seededClaimsByExternalId.set(claim.externalClaimId, { id: seededClaim.id });
  }

  const seededErrorClaim = seededClaimsByExternalId.get("seed-claim-004");
  if (!seededErrorClaim) {
    throw new Error("Expected seeded error claim to exist.");
  }

  const seededRetryableErrorClaim = seededClaimsByExternalId.get("seed-claim-006");
  if (!seededRetryableErrorClaim) {
    throw new Error("Expected seeded retryable error claim to exist.");
  }

  const seededStaleProcessingClaim = seededClaimsByExternalId.get("seed-claim-007");
  if (!seededStaleProcessingClaim) {
    throw new Error("Expected seeded stale processing claim to exist.");
  }

  const existingWorkerFailureEvent = await prisma.claimEvent.findFirst({
    where: {
      organizationId: organization.id,
      claimId: seededErrorClaim.id,
      eventType: "STATUS_TRANSITION",
      payload: {
        path: ["source"],
        equals: "worker_failure",
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
    },
  });

  const workerFailurePayload = {
    fromStatus: "PROCESSING",
    toStatus: "ERROR",
    source: "worker_failure",
    reason: "Document classification failed after OCR fallback.",
    retryable: false,
    receiveCount: 4,
    failureDisposition: "moved_to_dlq",
  } as const;

  const seededErrorWorkerFailureEventId = existingWorkerFailureEvent?.id;
  if (existingWorkerFailureEvent) {
    await prisma.claimEvent.update({
      where: {
        id: existingWorkerFailureEvent.id,
      },
      data: {
        actorUserId: null,
        payload: workerFailurePayload,
      },
    });
  } else {
    const createdWorkerFailureEvent = await prisma.claimEvent.create({
      data: {
        organizationId: organization.id,
        claimId: seededErrorClaim.id,
        actorUserId: null,
        eventType: "STATUS_TRANSITION",
        payload: workerFailurePayload,
      },
    });

    await prisma.$executeRaw`
      UPDATE "ClaimEvent"
      SET "createdAt" = ${new Date("2026-02-20T09:00:00.000Z")}
      WHERE "id" = ${createdWorkerFailureEvent.id}
    `;
  }

  if (seededErrorWorkerFailureEventId) {
    await prisma.$executeRaw`
      UPDATE "ClaimEvent"
      SET "createdAt" = ${new Date("2026-02-20T09:00:00.000Z")}
      WHERE "id" = ${seededErrorWorkerFailureEventId}
    `;
  }

  await setClaimLatestWorkerFailureSnapshot(seededErrorClaim.id, {
    occurredAt: new Date("2026-02-20T09:00:00.000Z"),
    reason: workerFailurePayload.reason,
    retryable: workerFailurePayload.retryable,
    receiveCount: workerFailurePayload.receiveCount,
    failureDisposition: workerFailurePayload.failureDisposition,
  });

  const existingRetryableWorkerFailureEvent = await prisma.claimEvent.findFirst({
    where: {
      organizationId: organization.id,
      claimId: seededRetryableErrorClaim.id,
      eventType: "STATUS_TRANSITION",
      payload: {
        path: ["source"],
        equals: "worker_failure",
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
    },
  });

  const retryableWorkerFailurePayload = {
    fromStatus: "PROCESSING",
    toStatus: "ERROR",
    source: "worker_failure",
    reason: "OpenAI extraction request timed out before completion.",
    retryable: true,
    receiveCount: 2,
    failureDisposition: "retrying",
  } as const;

  const seededRetryableWorkerFailureEventId = existingRetryableWorkerFailureEvent?.id;
  if (existingRetryableWorkerFailureEvent) {
    await prisma.claimEvent.update({
      where: {
        id: existingRetryableWorkerFailureEvent.id,
      },
      data: {
        actorUserId: null,
        payload: retryableWorkerFailurePayload,
      },
    });
  } else {
    const createdRetryableWorkerFailureEvent = await prisma.claimEvent.create({
      data: {
        organizationId: organization.id,
        claimId: seededRetryableErrorClaim.id,
        actorUserId: null,
        eventType: "STATUS_TRANSITION",
        payload: retryableWorkerFailurePayload,
      },
    });

    await prisma.$executeRaw`
      UPDATE "ClaimEvent"
      SET "createdAt" = ${new Date("2026-01-15T09:00:00.000Z")}
      WHERE "id" = ${createdRetryableWorkerFailureEvent.id}
    `;
  }

  if (seededRetryableWorkerFailureEventId) {
    await prisma.$executeRaw`
      UPDATE "ClaimEvent"
      SET "createdAt" = ${new Date("2026-01-15T09:00:00.000Z")}
      WHERE "id" = ${seededRetryableWorkerFailureEventId}
    `;
  }

  await setClaimLatestWorkerFailureSnapshot(seededRetryableErrorClaim.id, {
    occurredAt: new Date("2026-01-15T09:00:00.000Z"),
    reason: retryableWorkerFailurePayload.reason,
    retryable: retryableWorkerFailurePayload.retryable,
    receiveCount: retryableWorkerFailurePayload.receiveCount,
    failureDisposition: retryableWorkerFailurePayload.failureDisposition,
  });

  await prisma.inboundMessage.upsert({
    where: {
      organizationId_provider_providerMessageId: {
        organizationId: organization.id,
        provider: "POSTMARK",
        providerMessageId: "seed-provider-message-006",
      },
    },
    update: {
      claimId: seededRetryableErrorClaim.id,
      fromEmail: "dealer@example.com",
      toEmail: "claims+acme@inbound.claimflow.dev",
      subject: "Retryable seeded error claim",
      textBody: "Retryable seeded error claim inbound body.",
      rawPayload: { seeded: true, externalClaimId: "seed-claim-006" },
    },
    create: {
      organizationId: organization.id,
      provider: "POSTMARK",
      providerMessageId: "seed-provider-message-006",
      fromEmail: "dealer@example.com",
      toEmail: "claims+acme@inbound.claimflow.dev",
      subject: "Retryable seeded error claim",
      textBody: "Retryable seeded error claim inbound body.",
      rawPayload: { seeded: true, externalClaimId: "seed-claim-006" },
      claimId: seededRetryableErrorClaim.id,
    },
  });

  await prisma.inboundMessage.upsert({
    where: {
      organizationId_provider_providerMessageId: {
        organizationId: organization.id,
        provider: "POSTMARK",
        providerMessageId: "seed-provider-message-007",
      },
    },
    update: {
      claimId: seededStaleProcessingClaim.id,
      fromEmail: "dealer@example.com",
      toEmail: "claims+acme@inbound.claimflow.dev",
      subject: "Stale processing seeded claim",
      textBody: "This seeded claim is intentionally left in PROCESSING for recovery controls.",
      rawPayload: { seeded: true, externalClaimId: "seed-claim-007" },
    },
    create: {
      organizationId: organization.id,
      provider: "POSTMARK",
      providerMessageId: "seed-provider-message-007",
      fromEmail: "dealer@example.com",
      toEmail: "claims+acme@inbound.claimflow.dev",
      subject: "Stale processing seeded claim",
      textBody: "This seeded claim is intentionally left in PROCESSING for recovery controls.",
      rawPayload: { seeded: true, externalClaimId: "seed-claim-007" },
      claimId: seededStaleProcessingClaim.id,
    },
  });

  await prisma.$executeRaw`
    UPDATE "Claim"
    SET "updatedAt" = ${new Date("2026-01-01T12:00:00.000Z")}
    WHERE "id" = ${seededStaleProcessingClaim.id}
  `;

  const seededAttachmentClaim = seededClaimsByExternalId.get("seed-claim-005");
  if (!seededAttachmentClaim) {
    throw new Error("Expected seeded attachment claim to exist.");
  }

  const existingSeedAttachment = await prisma.claimAttachment.findFirst({
    where: {
      organizationId: organization.id,
      claimId: seededAttachmentClaim.id,
      originalFilename: "installer-report.pdf",
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
    },
  });

  const seedAttachmentData = {
    organizationId: organization.id,
    claimId: seededAttachmentClaim.id,
    storageProvider: "S3" as const,
    uploadStatus: "STORED" as const,
    originalFilename: "installer-report.pdf",
    contentType: "application/pdf",
    byteSize: 262_144,
    checksumSha256: "seed-attachment-checksum",
    s3Bucket: "seed-attachments",
    s3Key: `claims/${seededAttachmentClaim.id}/installer-report.pdf`,
    errorMessage: null,
  };

  if (existingSeedAttachment) {
    await prisma.claimAttachment.update({
      where: {
        id: existingSeedAttachment.id,
      },
      data: seedAttachmentData,
    });
  } else {
    await prisma.claimAttachment.create({
      data: seedAttachmentData,
    });
  }

  await prisma.integrationMailbox.upsert({
    where: {
      provider_mailboxHash: {
        provider: "POSTMARK",
        mailboxHash: "acme",
      },
    },
    update: {
      organizationId: organization.id,
      emailAddress: "claims+acme@inbound.claimflow.dev",
    },
    create: {
      organizationId: organization.id,
      provider: "POSTMARK",
      mailboxHash: "acme",
      emailAddress: "claims+acme@inbound.claimflow.dev",
    },
  });

  logSeedAdminSummary(seedAdmin);
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function resolveSeedAdminCredentials(): Promise<{
  email: string;
  fullName: string;
  passwordHash: string;
  passwordSource: "env" | "generated";
  generatedPassword: string | null;
}> {
  const email = readSeedAdminEmail();
  const configuredPassword = process.env.CLAIMFLOW_SEED_ADMIN_PASSWORD?.trim();
  const generatedPassword = configuredPassword ? null : generateSeedAdminPassword();
  const password = configuredPassword ?? generatedPassword;

  if (!password) {
    throw new Error("Seed admin password could not be resolved.");
  }

  return {
    email,
    fullName: DEFAULT_SEED_ADMIN_FULL_NAME,
    passwordHash: await hashPassword(password),
    passwordSource: configuredPassword ? "env" : "generated",
    generatedPassword,
  };
}

function readSeedAdminEmail(): string {
  const configuredEmail = process.env.CLAIMFLOW_SEED_ADMIN_EMAIL?.trim().toLowerCase();
  return configuredEmail || DEFAULT_SEED_ADMIN_EMAIL;
}

function generateSeedAdminPassword(): string {
  return `seed-${randomBytes(18).toString("hex")}`;
}

function logSeedAdminSummary(input: {
  email: string;
  passwordSource: "env" | "generated";
  generatedPassword: string | null;
}): void {
  console.log(`[seed] Admin login email: ${input.email}`);

  if (input.passwordSource === "env") {
    console.log("[seed] Admin password source: CLAIMFLOW_SEED_ADMIN_PASSWORD");
    return;
  }

  console.log(`[seed] Admin password generated for this seed run: ${input.generatedPassword}`);
}

async function setClaimLatestWorkerFailureSnapshot(
  claimId: string,
  input: {
    occurredAt: Date;
    reason: string | null;
    retryable: boolean | null;
    receiveCount: number | null;
    failureDisposition: string | null;
  },
) {
  await prisma.$executeRaw`
    UPDATE "Claim"
    SET
      "latestWorkerFailureAt" = ${input.occurredAt.toISOString()}::timestamp,
      "latestWorkerFailureReason" = ${input.reason},
      "latestWorkerFailureRetryable" = ${input.retryable},
      "latestWorkerFailureReceiveCount" = ${input.receiveCount},
      "latestWorkerFailureDisposition" = ${input.failureDisposition}
    WHERE "id" = ${claimId}
  `;
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error("Failed to seed database", error);
    await prisma.$disconnect();
    process.exit(1);
  });
