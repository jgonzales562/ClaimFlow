import { createPostmarkInboundHandler } from "@/lib/postmark/inbound-webhook";
import { revalidateClaimsOperationsCaches } from "@/lib/claims/cache-invalidation";

const postmarkInboundHandler = createPostmarkInboundHandler({
  revalidateDashboardSummaryCacheFn: revalidateClaimsOperationsCaches,
});

export async function POST(request: Request): Promise<Response> {
  return postmarkInboundHandler(request);
}
