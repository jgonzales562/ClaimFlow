const DEFAULT_PROCESSING_STALE_MINUTES = 30;

export function getClaimProcessingStaleMinutes(): number {
  const raw = process.env.CLAIMS_PROCESSING_STALE_MINUTES?.trim();
  if (!raw) {
    return DEFAULT_PROCESSING_STALE_MINUTES;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10_080) {
    throw new Error("CLAIMS_PROCESSING_STALE_MINUTES must be an integer between 1 and 10080.");
  }

  return parsed;
}

export function getClaimProcessingStaleBefore(
  now: Date = new Date(),
  staleMinutes: number = getClaimProcessingStaleMinutes(),
): Date {
  return new Date(now.getTime() - staleMinutes * 60_000);
}

export function isClaimProcessingStale(
  status: string,
  updatedAt: Date,
  options: {
    now?: Date;
    staleMinutes?: number;
  } = {},
): boolean {
  if (status !== "PROCESSING") {
    return false;
  }

  const staleBefore = getClaimProcessingStaleBefore(options.now, options.staleMinutes);
  return updatedAt.getTime() <= staleBefore.getTime();
}
