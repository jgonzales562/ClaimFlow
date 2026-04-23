import type { ClaimStatus, Prisma } from "@prisma/client";
import { CLAIM_EVENT_PAYLOAD_SCHEMA_VERSION } from "./json-schema-versions.js";

type ClaimStatusTransitionInput = {
  tx: Prisma.TransactionClient;
  organizationId: string;
  claimId: string;
  fromStatus: ClaimStatus;
  toStatus: ClaimStatus;
  actorUserId?: string | null;
  payload?: Prisma.InputJsonObject;
};

export async function recordClaimStatusTransition(
  input: ClaimStatusTransitionInput,
): Promise<void> {
  await input.tx.claimEvent.create({
    data: {
      organizationId: input.organizationId,
      claimId: input.claimId,
      actorUserId: input.actorUserId ?? null,
      eventType: "STATUS_TRANSITION",
      payloadSchemaVersion: CLAIM_EVENT_PAYLOAD_SCHEMA_VERSION,
      payload: {
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        ...(input.payload ?? {}),
      },
    },
  });
}

export async function transitionClaimStatusIfCurrent(
  input: ClaimStatusTransitionInput,
): Promise<boolean> {
  const transition = await input.tx.claim.updateMany({
    where: {
      id: input.claimId,
      organizationId: input.organizationId,
      status: input.fromStatus,
    },
    data: {
      status: input.toStatus,
    },
  });

  if (transition.count !== 1) {
    return false;
  }

  await recordClaimStatusTransition(input);
  return true;
}
