import { PrismaClient } from "@prisma/client";
export {
  CLAIM_PROCESSING_RECOVERY_SOURCES,
  CLAIM_PROCESSING_START_SOURCES,
  recordProcessingRecoveryIfStale,
  startClaimProcessingAttemptIfCurrent,
} from "./claim-processing.js";
export { recordClaimStatusTransition, transitionClaimStatusIfCurrent } from "./claim-status.js";

const prismaGlobal = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = prismaGlobal.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  prismaGlobal.prisma = prisma;
}
