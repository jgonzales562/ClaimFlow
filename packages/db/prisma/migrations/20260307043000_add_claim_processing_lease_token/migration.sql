ALTER TABLE "Claim"
ADD COLUMN "processingLeaseToken" TEXT,
ADD COLUMN "processingLeaseClaimedAt" TIMESTAMP(3);
