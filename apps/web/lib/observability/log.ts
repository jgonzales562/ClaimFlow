function shouldEmitStructuredLogs(): boolean {
  const isTestRuntime =
    process.env.NODE_ENV === "test" || Boolean(process.env.NODE_TEST_CONTEXT);
  return !isTestRuntime || process.env.CLAIMFLOW_ENABLE_TEST_LOGS === "true";
}

export function logInfo(event: string, context: Record<string, unknown>): void {
  if (!shouldEmitStructuredLogs()) {
    return;
  }

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
  if (!shouldEmitStructuredLogs()) {
    return;
  }

  console.error(
    JSON.stringify({
      level: "error",
      event,
      timestamp: new Date().toISOString(),
      ...context,
    }),
  );
}

export function extractErrorMessage(error: unknown, fallback = "Unknown error."): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}
