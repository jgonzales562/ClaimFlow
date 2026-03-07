import { createClaimsHealthHandler } from "@/lib/claims/health-route";

const claimsHealthHandler = createClaimsHealthHandler();

export async function GET(request: Request): Promise<Response> {
  return claimsHealthHandler(request);
}
