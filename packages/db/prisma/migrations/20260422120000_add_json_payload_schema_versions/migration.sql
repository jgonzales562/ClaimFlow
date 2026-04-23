ALTER TABLE "InboundMessage"
ADD COLUMN "rawPayloadSchemaVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "ClaimEvent"
ADD COLUMN "payloadSchemaVersion" INTEGER NOT NULL DEFAULT 1;
