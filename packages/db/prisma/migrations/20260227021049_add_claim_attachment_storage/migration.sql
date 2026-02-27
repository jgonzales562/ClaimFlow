-- CreateEnum
CREATE TYPE "AttachmentStorageProvider" AS ENUM ('S3');

-- CreateEnum
CREATE TYPE "AttachmentUploadStatus" AS ENUM ('STORED', 'FAILED');

-- CreateTable
CREATE TABLE "ClaimAttachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "inboundMessageId" TEXT,
    "storageProvider" "AttachmentStorageProvider" NOT NULL DEFAULT 'S3',
    "uploadStatus" "AttachmentUploadStatus" NOT NULL DEFAULT 'STORED',
    "originalFilename" TEXT NOT NULL,
    "contentType" TEXT,
    "byteSize" INTEGER NOT NULL,
    "checksumSha256" TEXT,
    "s3Bucket" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClaimAttachment_organizationId_createdAt_idx" ON "ClaimAttachment"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "ClaimAttachment_claimId_idx" ON "ClaimAttachment"("claimId");

-- CreateIndex
CREATE INDEX "ClaimAttachment_inboundMessageId_idx" ON "ClaimAttachment"("inboundMessageId");

-- AddForeignKey
ALTER TABLE "ClaimAttachment" ADD CONSTRAINT "ClaimAttachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimAttachment" ADD CONSTRAINT "ClaimAttachment_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimAttachment" ADD CONSTRAINT "ClaimAttachment_inboundMessageId_fkey" FOREIGN KEY ("inboundMessageId") REFERENCES "InboundMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
