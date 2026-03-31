-- CreateTable
CREATE TABLE "ClaimIngestQueueOutbox" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "inboundMessageId" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "queueUrl" TEXT NOT NULL,
    "processingAttempt" INTEGER NOT NULL,
    "processingLeaseToken" TEXT NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL,
    "dispatchAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastDispatchAttemptAt" TIMESTAMP(3),
    "lastDispatchError" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "sqsMessageId" TEXT,
    "dispatchLeaseToken" TEXT,
    "dispatchLeaseClaimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClaimIngestQueueOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClaimIngestQueueOutbox_organizationId_createdAt_idx" ON "ClaimIngestQueueOutbox"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "ClaimIngestQueueOutbox_claimId_createdAt_idx" ON "ClaimIngestQueueOutbox"("claimId", "createdAt");

-- CreateIndex
CREATE INDEX "ClaimIngestQueueOutbox_dispatch_state_idx" ON "ClaimIngestQueueOutbox"("dispatchedAt", "availableAt", "createdAt");

-- AddForeignKey
ALTER TABLE "ClaimIngestQueueOutbox" ADD CONSTRAINT "ClaimIngestQueueOutbox_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimIngestQueueOutbox" ADD CONSTRAINT "ClaimIngestQueueOutbox_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
