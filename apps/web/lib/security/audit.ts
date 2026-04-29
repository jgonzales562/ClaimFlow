import { AUDIT_EVENT_PAYLOAD_SCHEMA_VERSION, prisma } from "@claimflow/db";
import type { Prisma } from "@prisma/client";

export type WebAuditEventType = "CLAIM_EXPORT" | "ATTACHMENT_ACCESS";

export type RecordWebAuditEventInput = {
  organizationId: string;
  actorUserId: string | null;
  eventType: WebAuditEventType;
  payload: Prisma.InputJsonObject;
};

export async function recordWebAuditEvent(input: RecordWebAuditEventInput): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      eventType: input.eventType,
      payloadSchemaVersion: AUDIT_EVENT_PAYLOAD_SCHEMA_VERSION,
      payload: input.payload,
    },
  });
}
