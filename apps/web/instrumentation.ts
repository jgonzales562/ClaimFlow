import { initWebSentry } from "@/lib/observability/sentry";

export async function register(): Promise<void> {
  initWebSentry();
}
