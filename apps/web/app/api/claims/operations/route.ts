import { createClaimsOperationsHandler } from "@/lib/claims/operations-route";

const claimsOperationsHandler = createClaimsOperationsHandler();

export async function GET(): Promise<Response> {
  return claimsOperationsHandler();
}
