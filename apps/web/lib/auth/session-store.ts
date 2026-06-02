import { randomUUID } from "node:crypto";
import { prisma } from "@claimflow/db";
import type { PrismaClient } from "@prisma/client";
import { verifySessionToken, type MembershipRole } from "./session";

type AuthSessionStoreClient = Pick<PrismaClient, "authSession">;

export type CreateAuthSessionInput = {
  userId: string;
  organizationId: string;
  role: MembershipRole;
  expiresAt: Date;
};

export type CreatedAuthSession = {
  id: string;
  expiresAt: Date;
};

export async function createAuthSession(
  input: CreateAuthSessionInput,
  dependencies: { prismaClient?: AuthSessionStoreClient; sessionIdFn?: () => string } = {},
): Promise<CreatedAuthSession> {
  const prismaClient = dependencies.prismaClient ?? prisma;
  const id = dependencies.sessionIdFn?.() ?? randomUUID();

  const session = await prismaClient.authSession.create({
    data: {
      id,
      userId: input.userId,
      organizationId: input.organizationId,
      role: input.role,
      expiresAt: input.expiresAt,
    },
    select: {
      id: true,
      expiresAt: true,
    },
  });

  return session;
}

export async function revokeAuthSessionToken(
  token: string,
  dependencies: { prismaClient?: AuthSessionStoreClient; nowFn?: () => Date } = {},
): Promise<boolean> {
  const payload = verifySessionToken(token);
  if (!payload) {
    return false;
  }

  const prismaClient = dependencies.prismaClient ?? prisma;
  const revokedAt = dependencies.nowFn?.() ?? new Date();
  const result = await prismaClient.authSession.updateMany({
    where: {
      id: payload.sessionId,
      userId: payload.userId,
      organizationId: payload.organizationId,
      revokedAt: null,
    },
    data: {
      revokedAt,
    },
  });

  return result.count === 1;
}
