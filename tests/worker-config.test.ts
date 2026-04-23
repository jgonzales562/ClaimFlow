import assert from "node:assert/strict";
import { test } from "node:test";
import { loadWorkerConfig } from "../apps/worker/src/config.ts";

test("worker config reads outbox dispatch tuning settings from env", () => {
  withEnv(
    {
      CLAIMS_INGEST_QUEUE_URL: "https://example.invalid/claims",
      AWS_REGION: "us-east-1",
      CLAIMS_ALLOW_HEURISTIC_FALLBACK: "true",
      CLAIMS_INGEST_OUTBOX_DISPATCH_BATCH_SIZE: "40",
      CLAIMS_INGEST_OUTBOX_DISPATCH_CONCURRENCY: "7",
      CLAIMS_INGEST_OUTBOX_DISPATCH_MAX_BATCHES_PER_RUN: "9",
      CLAIMS_PROCESSING_WATCHDOG_CONCURRENCY: "6",
    },
    () => {
      const config = loadWorkerConfig();

      assert.equal(config.ingestQueueOutboxDispatchBatchSize, 40);
      assert.equal(config.ingestQueueOutboxDispatchConcurrency, 7);
      assert.equal(config.ingestQueueOutboxDispatchMaxBatchesPerRun, 9);
      assert.equal(config.processingWatchdogConcurrency, 6);
      assert.equal(config.allowHeuristicFallback, true);
    },
  );
});

test("worker config falls back to the default outbox dispatch tuning values", () => {
  withEnv(
    {
      CLAIMS_INGEST_QUEUE_URL: "https://example.invalid/claims",
      AWS_REGION: "us-east-1",
      NODE_ENV: "development",
      OPENAI_API_KEY: undefined,
      CLAIMS_ALLOW_HEURISTIC_FALLBACK: undefined,
      CLAIMS_INGEST_OUTBOX_DISPATCH_BATCH_SIZE: undefined,
      CLAIMS_INGEST_OUTBOX_DISPATCH_CONCURRENCY: undefined,
      CLAIMS_INGEST_OUTBOX_DISPATCH_MAX_BATCHES_PER_RUN: undefined,
      CLAIMS_PROCESSING_WATCHDOG_CONCURRENCY: undefined,
    },
    () => {
      const config = loadWorkerConfig();

      assert.equal(config.ingestQueueOutboxDispatchBatchSize, 25);
      assert.equal(config.ingestQueueOutboxDispatchConcurrency, 5);
      assert.equal(config.ingestQueueOutboxDispatchMaxBatchesPerRun, 4);
      assert.equal(config.processingWatchdogConcurrency, 5);
      assert.equal(config.allowHeuristicFallback, true);
    },
  );
});

test("worker config requires explicit heuristic fallback when OpenAI is not configured in production", () => {
  withEnv(
    {
      CLAIMS_INGEST_QUEUE_URL: "https://example.invalid/claims",
      AWS_REGION: "us-east-1",
      NODE_ENV: "production",
      OPENAI_API_KEY: undefined,
      CLAIMS_ALLOW_HEURISTIC_FALLBACK: undefined,
    },
    () => {
      assert.throws(
        () => loadWorkerConfig(),
        /OPENAI_API_KEY is required unless CLAIMS_ALLOW_HEURISTIC_FALLBACK=true/,
      );
    },
  );
});

test("worker config allows explicit heuristic fallback without OpenAI in production", () => {
  withEnv(
    {
      CLAIMS_INGEST_QUEUE_URL: "https://example.invalid/claims",
      AWS_REGION: "us-east-1",
      NODE_ENV: "production",
      OPENAI_API_KEY: undefined,
      CLAIMS_ALLOW_HEURISTIC_FALLBACK: "true",
    },
    () => {
      const config = loadWorkerConfig();

      assert.equal(config.openAiApiKey, null);
      assert.equal(config.allowHeuristicFallback, true);
    },
  );
});

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  const previousValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    previousValues.set(key, process.env[key]);
    if (typeof value === "undefined") {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    run();
  } finally {
    for (const [key, value] of previousValues) {
      if (typeof value === "undefined") {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
