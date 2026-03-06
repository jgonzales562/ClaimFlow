import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import { ClaimStatus, MembershipRole, PrismaClient, WarrantyStatus } from "@prisma/client";

const prisma = new PrismaClient();
const scrypt = promisify(scryptCallback);

async function main(): Promise<void> {
  const adminPasswordHash = await hashPassword("Moonbeem7!");

  const organization = await prisma.organization.upsert({
    where: { slug: "acme-warranty" },
    update: { name: "Acme Warranty Operations" },
    create: {
      name: "Acme Warranty Operations",
      slug: "acme-warranty",
    },
  });

  const adminUser = await prisma.user.upsert({
    where: { email: "admin@claimflow.local" },
    update: {
      fullName: "ClaimFlow Admin",
      passwordHash: adminPasswordHash,
    },
    create: {
      email: "admin@claimflow.local",
      fullName: "ClaimFlow Admin",
      passwordHash: adminPasswordHash,
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
    await prisma.claimEvent.create({
      data: {
        organizationId: organization.id,
        claimId: seededErrorClaim.id,
        actorUserId: null,
        eventType: "STATUS_TRANSITION",
        payload: workerFailurePayload,
      },
    });
  }

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
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
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
