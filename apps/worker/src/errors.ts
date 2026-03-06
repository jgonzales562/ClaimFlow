export function extractErrorMessage(error: unknown, fallback = "Unknown error."): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}
