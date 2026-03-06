import { createAttachmentDownloadHandler } from "@/lib/claims/attachment-download-route";

type RouteContext = {
  params: Promise<{
    claimId: string;
    attachmentId: string;
  }>;
};

const attachmentDownloadHandler = createAttachmentDownloadHandler();

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return attachmentDownloadHandler(request, await context.params);
}
