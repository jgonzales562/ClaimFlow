import * as Sentry from "@sentry/node";
import type { WorkerConfig } from "./config.js";

let workerSentryEnabled = false;

export function initWorkerSentry(config: WorkerConfig): void {
  if (!config.sentryDsn || workerSentryEnabled) {
    return;
  }

  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.sentryEnvironment,
    tracesSampleRate: config.sentryTracesSampleRate,
  });

  workerSentryEnabled = true;
}

export function isWorkerSentryEnabled(): boolean {
  return workerSentryEnabled;
}

export function captureWorkerException(
  error: unknown,
  context: Record<string, string | number | boolean | null | undefined>,
): void {
  if (!workerSentryEnabled) {
    return;
  }

  const captureTarget = error instanceof Error ? error : new Error(String(error));

  Sentry.withScope((scope) => {
    scope.setTag("service", "worker");
    for (const [key, value] of Object.entries(context)) {
      if (value === undefined) {
        continue;
      }
      scope.setExtra(key, value);
    }

    Sentry.captureException(captureTarget);
  });
}

export function logInfo(event: string, context: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      level: "info",
      event,
      timestamp: new Date().toISOString(),
      ...context,
    }),
  );
}

export function logError(event: string, context: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      timestamp: new Date().toISOString(),
      ...context,
    }),
  );
}
