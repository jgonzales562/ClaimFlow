import { prisma } from "@claimflow/db";
import { cookies } from "next/headers";
import {
  isMembershipRole,
  SESSION_COOKIE_NAME,
  type MembershipRole,
  verifySessionToken,
} from "./session";

const ROLE_RANK: Record<MembershipRole, number> = {
  VIEWER: 1,
  ANALYST: 2,
  ADMIN: 3,
  OWNER: 4,
};

type AuthContext = {
  userId: string;
  email: string;
  organizationId: string;
  organizationName: string;
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
    select: {
      role: true,
      user: {
        select: {
          email: true,
        },
      },
      organization: {
        select: {
          name: true,
        },
      },
    },
  });

  if (!membership) {
    return null;
  }

  if (!isMembershipRole(membership.role)) {
    return null;
  }

  return {
    userId: payload.userId,
    email: membership.user.email,
    organizationId: payload.organizationId,
    organizationName: membership.organization.name,
    role: membership.role,
  };
}

export function hasMinimumRole(currentRole: MembershipRole, requiredRole: MembershipRole): boolean {
  return ROLE_RANK[currentRole] >= ROLE_RANK[requiredRole];
}
