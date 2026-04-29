import { headers } from "next/headers";
import { buildExpectedOriginFromHeaders, checkSameOrigin } from "./same-origin";

export async function assertSameOriginServerAction(): Promise<boolean> {
  const headerStore = await headers();
  const expectedOrigin = buildExpectedOriginFromHeaders({
    host: headerStore.get("host"),
    forwardedHost: headerStore.get("x-forwarded-host"),
    forwardedProto: headerStore.get("x-forwarded-proto"),
  });

  if (!expectedOrigin) {
    return false;
  }

  return checkSameOrigin({
    expectedOrigin,
    origin: headerStore.get("origin"),
    referer: headerStore.get("referer"),
  }).ok;
}
