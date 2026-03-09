import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 10_000;

export async function executeClaimsHealthCheck({
  fetchFn = fetch,
  env = process.env,
} = {}) {
  const healthUrl = readRequiredEnv(env, "CLAIMS_HEALTHCHECK_URL");
  const bearerToken = readRequiredEnv(env, "CLAIMS_HEALTH_BEARER_TOKEN");
  const timeoutMs = parseTimeoutMs(env.CLAIMS_HEALTHCHECK_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(healthUrl, {
      method: "GET",
      headers: {
        authorization: `Bearer ${bearerToken}`,
      },
      cache: "no-store",
      signal: controller.signal,
    });

    const bodyText = await response.text();
    const body = parseJson(bodyText);
    const summary = buildSummary(response.status, body, bodyText);

    return {
      ok: response.ok,
      status: response.status,
      summary,
      body,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Claims health check timed out after ${timeoutMs}ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function buildSummary(status, body, fallbackText = "") {
  const staleProcessing = readNumber(body, ["checks", "staleProcessing", "observedCount"]);
  const affectedOrganizations = readNumber(body, [
    "checks",
    "staleProcessing",
    "affectedOrganizations",
  ]);
  const overallStatus = readString(body, ["status"]);

  if (status >= 200 && status < 300) {
    return [
      "Claims health OK",
      formatStaleCounts(staleProcessing, affectedOrganizations),
      overallStatus ? `status=${overallStatus}` : null,
    ]
      .filter(Boolean)
      .join(" | ");
  }

  const errorMessage = readString(body, ["error"]);
  return [
    `Claims health check failed with ${status}`,
    overallStatus ? `status=${overallStatus}` : null,
    formatStaleCounts(staleProcessing, affectedOrganizations),
    errorMessage,
    !body && fallbackText ? fallbackText.trim().slice(0, 200) : null,
  ]
    .filter(Boolean)
    .join(" | ");
}

function formatStaleCounts(staleProcessing, affectedOrganizations) {
  if (typeof staleProcessing !== "number") {
    return null;
  }

  if (typeof affectedOrganizations === "number") {
    return `${staleProcessing} stale processing claims across ${affectedOrganizations} organizations`;
  }

  return `${staleProcessing} stale processing claims`;
}

function readRequiredEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function parseTimeoutMs(raw) {
  const value = raw?.trim();
  if (!value) {
    return DEFAULT_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1_000 || parsed > 120_000) {
    throw new Error("CLAIMS_HEALTHCHECK_TIMEOUT_MS must be an integer between 1000 and 120000.");
  }

  return parsed;
}

function parseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readString(body, path) {
  const value = readPath(body, path);
  return typeof value === "string" ? value : null;
}

function readNumber(body, path) {
  const value = readPath(body, path);
  return typeof value === "number" ? value : null;
}

function readPath(body, path) {
  let current = body;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return null;
    }
    current = current[key];
  }
  return current;
}

async function main() {
  try {
    const result = await executeClaimsHealthCheck();
    if (result.ok) {
      console.log(result.summary);
      return;
    }

    console.error(result.summary);
    process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown health check failure.";
    console.error(message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
