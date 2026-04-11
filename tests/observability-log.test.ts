import assert from "node:assert/strict";
import { test } from "node:test";
import {
  logError as logWebError,
  logInfo as logWebInfo,
} from "../apps/web/lib/observability/log.ts";
import {
  logError as logWorkerError,
  logInfo as logWorkerInfo,
} from "../apps/worker/src/observability.ts";

test("structured loggers stay silent by default in test env", async () => {
  await withPatchedLoggingEnv(
    {
      NODE_ENV: "test",
      CLAIMFLOW_ENABLE_TEST_LOGS: undefined,
    },
    () => {
      const logLines: string[] = [];
      const errorLines: string[] = [];

      return withPatchedConsole({ logLines, errorLines }, () => {
        logWebInfo("web_info_suppressed", { route: "/dashboard" });
        logWebError("web_error_suppressed", { route: "/dashboard/errors" });
        logWorkerInfo("worker_info_suppressed", { job: "ingest" });
        logWorkerError("worker_error_suppressed", { job: "ingest" });

        assert.deepEqual(logLines, []);
        assert.deepEqual(errorLines, []);
      });
    },
  );
});

test("structured loggers stay silent under the node test runner marker", async () => {
  await withPatchedLoggingEnv(
    {
      NODE_ENV: undefined,
      NODE_TEST_CONTEXT: "child-v8",
      CLAIMFLOW_ENABLE_TEST_LOGS: undefined,
    },
    () => {
      const logLines: string[] = [];
      const errorLines: string[] = [];

      return withPatchedConsole({ logLines, errorLines }, () => {
        logWebInfo("web_info_runner_suppressed", { route: "/dashboard" });
        logWorkerError("worker_error_runner_suppressed", { job: "ingest" });

        assert.deepEqual(logLines, []);
        assert.deepEqual(errorLines, []);
      });
    },
  );
});

test("structured loggers can be re-enabled explicitly in test env", async () => {
  await withPatchedLoggingEnv(
    {
      NODE_ENV: "test",
      CLAIMFLOW_ENABLE_TEST_LOGS: "true",
    },
    () => {
      const logLines: string[] = [];
      const errorLines: string[] = [];

      return withPatchedConsole({ logLines, errorLines }, () => {
        logWebInfo("web_info_enabled", { route: "/dashboard" });
        logWebError("web_error_enabled", { route: "/dashboard/errors" });
        logWorkerInfo("worker_info_enabled", { job: "ingest" });
        logWorkerError("worker_error_enabled", { job: "ingest" });

        assert.equal(logLines.length, 2);
        assert.equal(errorLines.length, 2);
        assert.equal(JSON.parse(logLines[0] ?? "{}").event, "web_info_enabled");
        assert.equal(JSON.parse(logLines[1] ?? "{}").event, "worker_info_enabled");
        assert.equal(JSON.parse(errorLines[0] ?? "{}").event, "web_error_enabled");
        assert.equal(JSON.parse(errorLines[1] ?? "{}").event, "worker_error_enabled");
      });
    },
  );
});

async function withPatchedLoggingEnv(
  env: Record<string, string | undefined>,
  callback: () => Promise<void> | void,
) {
  const previousValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(env)) {
    previousValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await callback();
  } finally {
    for (const [key, value] of previousValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function withPatchedConsole(
  input: {
    logLines: string[];
    errorLines: string[];
  },
  callback: () => void,
): void {
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;

  console.log = (value?: unknown, ...rest: unknown[]) => {
    input.logLines.push([value, ...rest].map(String).join(" "));
  };
  console.error = (value?: unknown, ...rest: unknown[]) => {
    input.errorLines.push([value, ...rest].map(String).join(" "));
  };

  try {
    callback();
  } finally {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }
}
