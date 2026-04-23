import { loadClaimIngestQueueOutboxSummary, prisma } from "@claimflow/db";
import type { ClaimStatus } from "./filters";
import { type DashboardOperationalActivity } from "./dashboard-claims";
import { loadClaimOperationalActivity } from "./operational-activity";
import { getClaimProcessingStaleBefore, getClaimProcessingStaleMinutes } from "./processing-health";
import { loadClaimStatusSummary } from "./status-summary";

export type ClaimsOperationsHealthSnapshot = {
  totalClaims: number;
  statusCounts: Record<ClaimStatus, number>;
  staleProcessingCount: number;
  staleProcessingOrganizationCount: number;
  extractionConfig: ClaimsExtractionConfiguration;
  operationalActivity: DashboardOperationalActivity;
  ingestQueueOutbox: {
    pendingCount: number;
    dueCount: number;
    oldestPendingAgeMinutes: number | null;
    oldestPendingCreatedAt: Date | null;
    oldestDueAgeMinutes: number | null;
    oldestDueAvailableAt: Date | null;
  };
};

export type ClaimsExtractionConfiguration = {
  mode: "openai" | "heuristic_fallback";
  openAiConfigured: boolean;
  heuristicFallbackAllowed: boolean;
};

const DEFAULT_MAX_STALE_PROCESSING_COUNT = 0;
const DEFAULT_MAX_DUE_OUTBOX_COUNT = 0;

export async function loadClaimsOperationsHealthSnapshot(
  input: {
    now?: Date;
  } = {},
): Promise<ClaimsOperationsHealthSnapshot> {
  const now = input.now ?? new Date();
  const staleProcessingBefore = getClaimProcessingStaleBefore(now);
  const extractionConfig = getClaimsExtractionConfiguration();

  const [statusSummary, operationalActivity, ingestQueueOutbox] = await Promise.all([
    loadClaimStatusSummary({
      staleProcessingBefore,
    }),
    loadClaimOperationalActivity({
      now,
    }),
    loadClaimIngestQueueOutboxSummary({
      prismaClient: prisma,
      now,
    }),
  ]);

  return {
    totalClaims: statusSummary.totalClaims,
    statusCounts: statusSummary.statusCounts,
    staleProcessingCount: statusSummary.staleProcessingCount,
    staleProcessingOrganizationCount: statusSummary.staleProcessingOrganizationCount,
    extractionConfig,
    operationalActivity,
    ingestQueueOutbox,
  };
}

export function getClaimsHealthMaxStaleProcessingCount(): number {
  const raw = process.env.CLAIMS_HEALTH_MAX_STALE_PROCESSING_COUNT?.trim();
  if (!raw) {
    return DEFAULT_MAX_STALE_PROCESSING_COUNT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000) {
    throw new Error(
      "CLAIMS_HEALTH_MAX_STALE_PROCESSING_COUNT must be an integer between 0 and 1000000.",
    );
  }

  return parsed;
}

export function getClaimsHealthBearerToken(): string | null {
  const token = process.env.CLAIMS_HEALTH_BEARER_TOKEN?.trim();
  return token ? token : null;
}

export function getClaimsHealthMaxDueOutboxCount(): number {
  const raw = process.env.CLAIMS_HEALTH_MAX_DUE_OUTBOX_COUNT?.trim();
  if (!raw) {
    return DEFAULT_MAX_DUE_OUTBOX_COUNT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000) {
    throw new Error("CLAIMS_HEALTH_MAX_DUE_OUTBOX_COUNT must be an integer between 0 and 1000000.");
  }

  return parsed;
}

export function isClaimsProcessingWatchdogEnabled(): boolean {
  const raw = process.env.CLAIMS_PROCESSING_WATCHDOG_ENABLED?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

export function getClaimsHealthStaleMinutes(): number {
  return getClaimProcessingStaleMinutes();
}

export function getClaimsExtractionConfiguration(): ClaimsExtractionConfiguration {
  const openAiConfigured = Boolean(process.env.OPENAI_API_KEY?.trim());
  const heuristicFallbackAllowed = getClaimsAllowHeuristicFallback();

  return {
    mode: openAiConfigured ? "openai" : "heuristic_fallback",
    openAiConfigured,
    heuristicFallbackAllowed,
  };
}

export function getClaimsAllowHeuristicFallback(): boolean {
  const raw = process.env.CLAIMS_ALLOW_HEURISTIC_FALLBACK?.trim().toLowerCase();
  if (!raw) {
    return defaultAllowHeuristicFallback();
  }

  if (raw === "true" || raw === "1" || raw === "yes") {
    return true;
  }

  if (raw === "false" || raw === "0" || raw === "no") {
    return false;
  }

  throw new Error("CLAIMS_ALLOW_HEURISTIC_FALLBACK must be a boolean value (true/false).");
}

function defaultAllowHeuristicFallback(): boolean {
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  return !nodeEnv || nodeEnv === "development" || nodeEnv === "test";
}
