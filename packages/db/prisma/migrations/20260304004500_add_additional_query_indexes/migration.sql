-- CreateIndex
CREATE INDEX "Claim_organizationId_status_updatedAt_idx" ON "Claim"("organizationId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "InboundMessage_claimId_createdAt_idx" ON "InboundMessage"("claimId", "createdAt");

-- CreateIndex
CREATE INDEX "ClaimAttachment_claimId_uploadStatus_createdAt_idx" ON "ClaimAttachment"("claimId", "uploadStatus", "createdAt");
