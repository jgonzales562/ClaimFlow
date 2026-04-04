import { createClaimsHealthHandler } from "@/lib/claims/health-route";
import { loadCachedClaimsOperationsHealthSnapshot } from "@/lib/claims/health-snapshot-cache";

const claimsHealthHandler = createClaimsHealthHandler({
  loadClaimsOperationsHealthSnapshotFn: loadCachedClaimsOperationsHealthSnapshot,
});

export async function GET(request: Request): Promise<Response> {
  return claimsHealthHandler(request);
}
