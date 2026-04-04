import { createClaimsOperationsHandler } from "@/lib/claims/operations-route";
import { loadCachedDashboardOperationalSummary } from "@/lib/claims/dashboard-summary-cache";

const claimsOperationsHandler = createClaimsOperationsHandler({
  loadDashboardOperationalSummaryFn: loadCachedDashboardOperationalSummary,
});

export async function GET(): Promise<Response> {
  return claimsOperationsHandler();
}
