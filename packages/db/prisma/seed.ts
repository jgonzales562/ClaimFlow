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

  await prisma.claim.upsert({
    where: {
      organizationId_externalClaimId: {
        organizationId: organization.id,
        externalClaimId: "seed-claim-001",
      },
    },
    update: {
      status: ClaimStatus.REVIEW_REQUIRED,
      issueSummary: "Compressor failure after abnormal noise and cooling loss.",
      missingInfo: ["installation_receipt"],
    },
    create: {
      organizationId: organization.id,
      createdByUserId: adminUser.id,
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
