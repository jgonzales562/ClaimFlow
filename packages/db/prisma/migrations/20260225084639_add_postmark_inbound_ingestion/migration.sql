-- CreateEnum
CREATE TYPE "InboundEmailProvider" AS ENUM ('POSTMARK');

-- CreateTable
CREATE TABLE "IntegrationMailbox" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "InboundEmailProvider" NOT NULL DEFAULT 'POSTMARK',
    "mailboxHash" TEXT NOT NULL,
    "emailAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationMailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundMessage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "InboundEmailProvider" NOT NULL DEFAULT 'POSTMARK',
    "providerMessageId" TEXT NOT NULL,
    "mailboxHash" TEXT,
    "fromEmail" TEXT,
    "fromName" TEXT,
    "toEmail" TEXT,
    "subject" TEXT,
    "receivedAt" TIMESTAMP(3),
    "textBody" TEXT,
    "htmlBody" TEXT,
    "strippedTextReply" TEXT,
    "rawPayload" JSONB NOT NULL,
    "claimId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrationMailbox_organizationId_idx" ON "IntegrationMailbox"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationMailbox_provider_mailboxHash_key" ON "IntegrationMailbox"("provider", "mailboxHash");

-- CreateIndex
CREATE INDEX "InboundMessage_organizationId_createdAt_idx" ON "InboundMessage"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboundMessage_organizationId_provider_providerMessageId_key" ON "InboundMessage"("organizationId", "provider", "providerMessageId");

-- AddForeignKey
ALTER TABLE "IntegrationMailbox" ADD CONSTRAINT "IntegrationMailbox_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundMessage" ADD CONSTRAINT "InboundMessage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundMessage" ADD CONSTRAINT "InboundMessage_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE SET NULL ON UPDATE CASCADE;
