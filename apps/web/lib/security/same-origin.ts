export type SameOriginCheckResult =
  | { ok: true }
  | {
      ok: false;
      reason: "missing_origin" | "invalid_origin" | "origin_mismatch";
    };

export function assertSameOriginRequest(request: Request): SameOriginCheckResult {
  return checkSameOrigin({
    expectedOrigin: new URL(request.url).origin,
    origin: request.headers.get("origin"),
    referer: request.headers.get("referer"),
  });
}

export function checkSameOrigin(input: {
  expectedOrigin: string;
  origin?: string | null;
  referer?: string | null;
}): SameOriginCheckResult {
  const expectedOrigin = normalizeOrigin(input.expectedOrigin);
  if (!expectedOrigin) {
    return { ok: false, reason: "invalid_origin" };
  }

  const providedOrigin = input.origin?.trim();
  if (providedOrigin) {
    const normalizedProvidedOrigin = normalizeOrigin(providedOrigin);
    if (!normalizedProvidedOrigin) {
      return { ok: false, reason: "invalid_origin" };
    }

    return normalizedProvidedOrigin === expectedOrigin
      ? { ok: true }
      : { ok: false, reason: "origin_mismatch" };
  }

  const refererOrigin = getUrlOrigin(input.referer);
  if (refererOrigin) {
    return refererOrigin === expectedOrigin
      ? { ok: true }
      : { ok: false, reason: "origin_mismatch" };
  }

  return { ok: false, reason: "missing_origin" };
}

export function buildExpectedOriginFromHeaders(input: {
  host?: string | null;
  forwardedHost?: string | null;
  forwardedProto?: string | null;
  fallbackProto?: "http" | "https";
}): string | null {
  const host = input.forwardedHost?.trim() || input.host?.trim();
  if (!host) {
    return null;
  }

  const proto =
    input.forwardedProto?.split(",")[0]?.trim() ||
    input.fallbackProto ||
    (process.env.NODE_ENV === "production" ? "https" : "http");

  return normalizeOrigin(`${proto}://${host}`);
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function getUrlOrigin(value: string | null | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }

  return normalizeOrigin(value.trim());
}
