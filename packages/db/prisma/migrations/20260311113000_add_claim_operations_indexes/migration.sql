CREATE INDEX "Claim_status_updatedAt_id_idx"
ON "Claim"("status", "updatedAt", "id");

CREATE INDEX "ClaimEvent_organizationId_eventType_createdAt_idx"
ON "ClaimEvent"("organizationId", "eventType", "createdAt");

CREATE INDEX "ClaimEvent_eventType_createdAt_idx"
ON "ClaimEvent"("eventType", "createdAt");
