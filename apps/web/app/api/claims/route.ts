import { prisma } from "@claimflow/db";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getAuthContext, hasMinimumRole } from "@/lib/auth/server";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasMinimumRole(auth.role, "VIEWER")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const limitParam = Number.parseInt(request.nextUrl.searchParams.get("limit") ?? "25", 10);
  const limit = Number.isNaN(limitParam) ? 25 : Math.min(Math.max(limitParam, 1), 100);

  const claims = await prisma.claim.findMany({
    where: {
      organizationId: auth.organizationId,
    },
    orderBy: {
      createdAt: "desc",
    },
    take: limit,
    select: {
      id: true,
      externalClaimId: true,
      customerName: true,
      productName: true,
      status: true,
      warrantyStatus: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({
    claims,
    count: claims.length,
    organizationId: auth.organizationId,
  });
}
