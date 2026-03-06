import { createLogoutHandler } from "@/lib/auth/route-handlers";

const logoutHandler = createLogoutHandler();

export async function POST(request: Request): Promise<Response> {
  return logoutHandler(request);
}
