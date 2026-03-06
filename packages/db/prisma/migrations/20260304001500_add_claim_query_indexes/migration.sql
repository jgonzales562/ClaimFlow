-- CreateIndex
CREATE INDEX "Claim_organizationId_createdAt_id_idx" ON "Claim"("organizationId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "ClaimEvent_claimId_eventType_createdAt_idx" ON "ClaimEvent"("claimId", "eventType", "createdAt");
