import { revalidateDashboardSummaryCache } from "./dashboard-summary-cache";
import { revalidateClaimsHealthSnapshot } from "./health-snapshot-cache";

export function revalidateClaimsOperationsCaches(
  organizationId: string,
  dependencies: {
    revalidateDashboardSummaryCacheFn?: (organizationId: string) => void;
    revalidateClaimsHealthSnapshotFn?: () => void;
  } = {},
): void {
  (dependencies.revalidateDashboardSummaryCacheFn ?? revalidateDashboardSummaryCache)(
    organizationId,
  );
  (dependencies.revalidateClaimsHealthSnapshotFn ?? revalidateClaimsHealthSnapshot)();
}
