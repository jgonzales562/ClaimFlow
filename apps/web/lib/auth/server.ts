import { prisma } from "@claimflow/db";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, type MembershipRole, verifySessionToken } from "./session";

const ROLE_RANK: Record<MembershipRole, number> = {
  VIEWER: 1,
  ANALYST: 2,
  ADMIN: 3,
  OWNER: 4,
};

export type AuthContext = {
  userId: string;
  email: string;
  fullName: string | null;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: MembershipRole;
};

export async function getAuthContext(): Promise<AuthContext | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }

  const payload = verifySessionToken(token);
  if (!payload) {
    return null;
  }

  const membership = await prisma.membership.findUnique({
    where: {
      organizationId_userId: {
        organizationId: payload.organizationId,
        userId: payload.userId,
      },
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          fullName: true,
        },
      },
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  });

  if (!membership) {
    return null;
  }

  return {
    userId: membership.user.id,
    email: membership.user.email,
    fullName: membership.user.fullName,
    organizationId: membership.organization.id,
    organizationName: membership.organization.name,
    organizationSlug: membership.organization.slug,
    role: membership.role as MembershipRole,
  };
}

export function hasMinimumRole(currentRole: MembershipRole, requiredRole: MembershipRole): boolean {
  return ROLE_RANK[currentRole] >= ROLE_RANK[requiredRole];
}
