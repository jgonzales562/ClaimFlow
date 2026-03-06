import { createPostmarkInboundHandler } from "@/lib/postmark/inbound-webhook";

const postmarkInboundHandler = createPostmarkInboundHandler();

export async function POST(request: Request): Promise<Response> {
  return postmarkInboundHandler(request);
}
