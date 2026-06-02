import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { createAuthSession, revokeAuthSessionToken } from "../apps/web/lib/auth/session-store.ts";
import { createSessionToken } from "../apps/web/lib/auth/session.ts";
import { prisma } from "../packages/db/src/index.ts";

after(async () => {
  await prisma.$disconnect();
});

test("auth sessions can be revoked server-side by session token", async () => {
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: {
      name: `Session Store ${suffix}`,
      slug: `session-store-${suffix}`,
    },
    select: {
      id: true,
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `session-store-${suffix}@example.com`,
    },
    select: {
      id: true,
    },
  });

  try {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const session = await createAuthSession(
      {
        userId: user.id,
        organizationId: organization.id,
        role: "ADMIN",
        expiresAt,
      },
      {
        prismaClient: prisma,
        sessionIdFn: () => `session-${suffix}`,
      },
    );
    const token = createSessionToken(
      {
        sessionId: session.id,
        userId: user.id,
        organizationId: organization.id,
        role: "ADMIN",
      },
      expiresAt,
    );

    const revoked = await revokeAuthSessionToken(token, {
      prismaClient: prisma,
      nowFn: () => new Date("2026-03-05T12:00:00.000Z"),
    });

    assert.equal(revoked, true);

    const storedSession = await prisma.authSession.findUniqueOrThrow({
      where: {
        id: session.id,
      },
      select: {
        revokedAt: true,
      },
    });
    assert.equal(storedSession.revokedAt?.toISOString(), "2026-03-05T12:00:00.000Z");
  } finally {
    await prisma.organization.delete({
      where: {
        id: organization.id,
      },
    });
    await prisma.user.delete({
      where: {
        id: user.id,
      },
    });
  }
});
