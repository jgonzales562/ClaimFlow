import { createClaimsExportHandler } from "@/lib/claims/export-route";

const claimsExportHandler = createClaimsExportHandler();

export async function GET(request: Request): Promise<Response> {
  return claimsExportHandler(request);
}
