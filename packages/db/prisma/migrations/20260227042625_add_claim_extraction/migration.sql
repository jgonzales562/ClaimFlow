-- CreateEnum
CREATE TYPE "ClaimExtractionProvider" AS ENUM ('OPENAI', 'FALLBACK');

-- CreateTable
CREATE TABLE "ClaimExtraction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "inboundMessageId" TEXT,
    "provider" "ClaimExtractionProvider" NOT NULL DEFAULT 'OPENAI',
    "model" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "confidence" DOUBLE PRECISION NOT NULL,
    "extraction" JSONB NOT NULL,
    "rawOutput" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimExtraction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClaimExtraction_organizationId_createdAt_idx" ON "ClaimExtraction"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "ClaimExtraction_claimId_createdAt_idx" ON "ClaimExtraction"("claimId", "createdAt");

-- CreateIndex
CREATE INDEX "ClaimExtraction_inboundMessageId_idx" ON "ClaimExtraction"("inboundMessageId");

-- AddForeignKey
ALTER TABLE "ClaimExtraction" ADD CONSTRAINT "ClaimExtraction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimExtraction" ADD CONSTRAINT "ClaimExtraction_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimExtraction" ADD CONSTRAINT "ClaimExtraction_inboundMessageId_fkey" FOREIGN KEY ("inboundMessageId") REFERENCES "InboundMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
