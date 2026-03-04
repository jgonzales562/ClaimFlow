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

export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Unknown error.";
}
