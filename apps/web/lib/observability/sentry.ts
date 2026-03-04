import * as Sentry from "@sentry/nextjs";

let initialized = false;
let enabled = false;

export function initWebSentry(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    enabled = false;
    return;
  }

  const tracesSampleRate = parseTraceSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE);

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT?.trim() || process.env.NODE_ENV || "development",
    tracesSampleRate,
  });

  enabled = true;
}

export function captureWebException(
  error: unknown,
  context: Record<string, string | number | boolean | null | undefined> = {},
): void {
  initWebSentry();
  if (!enabled) {
    return;
  }

  const errorToCapture = error instanceof Error ? error : new Error(String(error));

  Sentry.withScope((scope) => {
    scope.setTag("service", "web");
    for (const [key, value] of Object.entries(context)) {
      if (value === undefined) {
        continue;
      }
      scope.setExtra(key, value);
    }

    Sentry.captureException(errorToCapture);
  });
}

function parseTraceSampleRate(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return 0.1;
  }

  return parsed;
}
