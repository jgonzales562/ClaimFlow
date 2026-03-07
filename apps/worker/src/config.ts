import type { ClaimIngestJobConfig } from "./ingest-job.js";

export type WorkerConfig = ClaimIngestJobConfig & {
  awsRegion: string;
  queueUrl: string;
  dlqUrl: string | null;
  processingStaleMinutes: number;
  processingWatchdogEnabled: boolean;
  processingWatchdogIntervalMs: number;
  processingWatchdogBatchSize: number;
  pollWaitSeconds: number;
  visibilityTimeoutSeconds: number | undefined;
  maxMessages: number;
  processingConcurrency: number;
  maxReceiveCount: number;
  idleDelayMs: number;
  errorDelayMs: number;
  sentryDsn: string | null;
  sentryEnvironment: string;
  sentryTracesSampleRate: number;
};

export function loadWorkerConfig(): WorkerConfig {
  const queueUrl = process.env.CLAIMS_INGEST_QUEUE_URL?.trim();
  if (!queueUrl) {
    throw new Error("CLAIMS_INGEST_QUEUE_URL is required for the worker.");
  }

  const awsRegion = process.env.AWS_REGION?.trim();
  if (!awsRegion) {
    throw new Error("AWS_REGION is required for the worker.");
  }

  return {
    awsRegion,
    queueUrl,
    dlqUrl: optionalEnv("CLAIMS_INGEST_DLQ_URL"),
    processingStaleMinutes: parseIntegerEnv("CLAIMS_PROCESSING_STALE_MINUTES", 30, 1, 10_080),
    processingWatchdogEnabled: parseBooleanEnv("CLAIMS_PROCESSING_WATCHDOG_ENABLED", false),
    processingWatchdogIntervalMs: parseIntegerEnv(
      "CLAIMS_PROCESSING_WATCHDOG_INTERVAL_MS",
      60_000,
      1_000,
      86_400_000,
    ),
    processingWatchdogBatchSize: parseIntegerEnv(
      "CLAIMS_PROCESSING_WATCHDOG_BATCH_SIZE",
      25,
      1,
      100,
    ),
    pollWaitSeconds: parseIntegerEnv("CLAIMS_QUEUE_POLL_WAIT_SECONDS", 20, 0, 20),
    visibilityTimeoutSeconds: parseOptionalIntegerEnv(
      "CLAIMS_QUEUE_VISIBILITY_TIMEOUT_SECONDS",
      0,
      43200,
    ),
    maxMessages: parseIntegerEnv("CLAIMS_QUEUE_MAX_MESSAGES", 5, 1, 10),
    processingConcurrency: parseIntegerEnv("CLAIMS_WORKER_CONCURRENCY", 1, 1, 10),
    maxReceiveCount: parseIntegerEnv("CLAIMS_QUEUE_MAX_RECEIVE_COUNT", 5, 1, 1000),
    idleDelayMs: parseIntegerEnv("CLAIMS_QUEUE_IDLE_DELAY_MS", 250, 0, 60_000),
    errorDelayMs: parseIntegerEnv("CLAIMS_QUEUE_ERROR_DELAY_MS", 2_000, 0, 60_000),
    openAiApiKey: optionalEnv("OPENAI_API_KEY"),
    extractionModel: optionalEnv("OPENAI_MODEL") ?? "gpt-4o-mini",
    extractionReadyConfidence: parseNumberEnv("CLAIMS_EXTRACTION_READY_CONFIDENCE", 0.85, 0, 1),
    extractionMaxInputChars: parseIntegerEnv(
      "CLAIMS_EXTRACTION_MAX_INPUT_CHARS",
      12_000,
      500,
      50_000,
    ),
    textractFallbackEnabled: parseBooleanEnv("CLAIMS_TEXTRACT_FALLBACK_ENABLED", true),
    textractFallbackConfidenceThreshold: parseNumberEnv(
      "CLAIMS_TEXTRACT_FALLBACK_CONFIDENCE_THRESHOLD",
      0.75,
      0,
      1,
    ),
    textractFallbackMissingInfoCount: parseIntegerEnv(
      "CLAIMS_TEXTRACT_FALLBACK_MISSING_INFO_COUNT",
      3,
      1,
      20,
    ),
    textractFallbackMinInboundChars: parseIntegerEnv(
      "CLAIMS_TEXTRACT_FALLBACK_MIN_INBOUND_CHARS",
      120,
      0,
      20_000,
    ),
    textractMaxAttachments: parseIntegerEnv("CLAIMS_TEXTRACT_MAX_ATTACHMENTS", 5, 1, 20),
    textractMaxTextChars: parseIntegerEnv("CLAIMS_TEXTRACT_MAX_TEXT_CHARS", 30_000, 500, 200_000),
    sentryDsn: optionalEnv("SENTRY_DSN"),
    sentryEnvironment:
      optionalEnv("SENTRY_ENVIRONMENT") ?? optionalEnv("NODE_ENV") ?? "development",
    sentryTracesSampleRate: parseNumberEnv("SENTRY_TRACES_SAMPLE_RATE", 0.1, 0, 1),
  };
}

function parseOptionalIntegerEnv(name: string, min: number, max: number): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }

  return value;
}

function parseIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }

  return value;
}

function parseNumberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}.`);
  }

  return value;
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }

  if (raw === "true" || raw === "1" || raw === "yes") {
    return true;
  }

  if (raw === "false" || raw === "0" || raw === "no") {
    return false;
  }

  throw new Error(`${name} must be a boolean value (true/false).`);
}

function optionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}
