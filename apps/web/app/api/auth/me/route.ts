import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/server";

export async function GET(): Promise<NextResponse> {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    user: {
      id: auth.userId,
      email: auth.email,
      fullName: auth.fullName,
      role: auth.role,
    },
    organization: {
      id: auth.organizationId,
      name: auth.organizationName,
      slug: auth.organizationSlug,
    },
  });
}
