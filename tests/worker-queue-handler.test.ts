import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleClaimQueueMessage,
  WorkerMessageError,
  type ClaimIngestQueueMessage,
} from "../apps/worker/src/queue-handler.ts";

test("worker deletes source messages after successful claim processing", async () => {
  const queueMessage = buildQueueMessage();
  const processedJobs: ClaimIngestQueueMessage[] = [];
  const loggedInfoEvents: Array<{ event: string; context: Record<string, unknown> }> = [];
  const loggedErrorEvents: Array<{ event: string; context: Record<string, unknown> }> = [];
  const commands = createCommandRecorder();

  await handleClaimQueueMessage(
    {
      config: {
        queueUrl: "https://example.invalid/claims",
        dlqUrl: "https://example.invalid/claims-dlq",
        maxReceiveCount: 5,
      },
      sqsClient: commands.client,
      sqsMessage: buildSqsMessage({
        Body: JSON.stringify(queueMessage),
        ReceiptHandle: "receipt-success",
      }),
    },
    {
      processClaimIngestJobFn: async (_config, message) => {
        processedJobs.push(message);
      },
      markClaimAsErrorFn: async () => {
        throw new Error("markClaimAsError should not be called on success");
      },
      logInfoFn: (event, context) => {
        loggedInfoEvents.push({ event, context });
      },
      logErrorFn: (event, context) => {
        loggedErrorEvents.push({ event, context });
      },
    },
  );

  assert.deepEqual(processedJobs, [queueMessage]);
  assert.deepEqual(
    loggedInfoEvents.map((entry) => entry.event),
    ["claim_ingest_processed"],
  );
  assert.equal(loggedErrorEvents.length, 0);

  const deleteCommands = commands.sent.filter((command) =>
    isCommand(command, "DeleteMessageCommand"),
  );
  assert.equal(deleteCommands.length, 1);
  assert.equal(deleteCommands[0].input.QueueUrl, "https://example.invalid/claims");
  assert.equal(deleteCommands[0].input.ReceiptHandle, "receipt-success");
});

test("worker extends message visibility while long claim processing is running", async () => {
  const queueMessage = buildQueueMessage();
  const commands = createCommandRecorder();

  await handleClaimQueueMessage(
    {
      config: {
        queueUrl: "https://example.invalid/claims",
        dlqUrl: "https://example.invalid/claims-dlq",
        maxReceiveCount: 5,
        visibilityTimeoutSeconds: 30,
        visibilityExtensionIntervalMs: 1,
      },
      sqsClient: commands.client,
      sqsMessage: buildSqsMessage({
        Body: JSON.stringify(queueMessage),
        ReceiptHandle: "receipt-long-running",
      }),
    },
    {
      processClaimIngestJobFn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
      markClaimAsErrorFn: async () => {
        throw new Error("markClaimAsError should not be called on success");
      },
      logInfoFn: () => {},
      logErrorFn: () => {},
    },
  );

  const visibilityCommands = commands.sent.filter((command) =>
    isCommand(command, "ChangeMessageVisibilityCommand"),
  );
  assert.ok(visibilityCommands.length >= 1);
  assert.equal(visibilityCommands[0]?.input.QueueUrl, "https://example.invalid/claims");
  assert.equal(visibilityCommands[0]?.input.ReceiptHandle, "receipt-long-running");
  assert.equal(visibilityCommands[0]?.input.VisibilityTimeout, 30);
});

test("worker routes malformed message bodies to the DLQ when configured", async () => {
  const loggedErrorEvents: Array<{ event: string; context: Record<string, unknown> }> = [];
  const commands = createCommandRecorder();
  const markClaimAsErrorCalls: Array<Record<string, unknown>> = [];

  await handleClaimQueueMessage(
    {
      config: {
        queueUrl: "https://example.invalid/claims",
        dlqUrl: "https://example.invalid/claims-dlq",
        maxReceiveCount: 5,
      },
      sqsClient: commands.client,
      sqsMessage: buildSqsMessage({
        Body: "{bad json",
        ReceiptHandle: "receipt-malformed",
      }),
    },
    {
      processClaimIngestJobFn: async () => {
        throw new Error("processClaimIngestJob should not be called for malformed messages");
      },
      markClaimAsErrorFn: async (input) => {
        markClaimAsErrorCalls.push(input);
      },
      logInfoFn: () => {
        throw new Error("logInfo should not be called for malformed messages");
      },
      logErrorFn: (event, context) => {
        loggedErrorEvents.push({ event, context });
      },
    },
  );

  assert.equal(markClaimAsErrorCalls.length, 0);
  assert.deepEqual(
    loggedErrorEvents.map((entry) => entry.event),
    ["claim_ingest_moved_to_dlq"],
  );

  const sendCommands = commands.sent.filter((command) => isCommand(command, "SendMessageCommand"));
  const deleteCommands = commands.sent.filter((command) =>
    isCommand(command, "DeleteMessageCommand"),
  );
  assert.equal(sendCommands.length, 1);
  assert.equal(deleteCommands.length, 1);

  const dlqBody = JSON.parse(String(sendCommands[0].input.MessageBody)) as Record<string, unknown>;
  assert.equal(dlqBody.reason, "SQS message body is not valid JSON.");
  assert.equal(dlqBody.queueMessage, null);
});

test("worker routes legacy queue message versions to the DLQ when configured", async () => {
  const loggedErrorEvents: Array<{ event: string; context: Record<string, unknown> }> = [];
  const commands = createCommandRecorder();

  await handleClaimQueueMessage(
    {
      config: {
        queueUrl: "https://example.invalid/claims",
        dlqUrl: "https://example.invalid/claims-dlq",
        maxReceiveCount: 5,
      },
      sqsClient: commands.client,
      sqsMessage: buildSqsMessage({
        Body: JSON.stringify({
          claimId: "claim-legacy",
          organizationId: "org-legacy",
          inboundMessageId: "inbound-legacy",
          providerMessageId: "provider-legacy",
          enqueuedAt: "2026-03-05T12:00:00.000Z",
          version: 2,
          processingAttempt: 1,
        }),
        ReceiptHandle: "receipt-legacy",
      }),
    },
    {
      processClaimIngestJobFn: async () => {
        throw new Error("processClaimIngestJob should not be called for legacy message versions");
      },
      markClaimAsErrorFn: async () => {
        throw new Error("markClaimAsError should not run without a parsed queue message");
      },
      logInfoFn: () => {
        throw new Error("logInfo should not be called for legacy message versions");
      },
      logErrorFn: (event, context) => {
        loggedErrorEvents.push({ event, context });
      },
    },
  );

  assert.deepEqual(
    loggedErrorEvents.map((entry) => entry.event),
    ["claim_ingest_moved_to_dlq"],
  );

  const sendCommands = commands.sent.filter((command) => isCommand(command, "SendMessageCommand"));
  assert.equal(sendCommands.length, 1);
  const dlqBody = JSON.parse(String(sendCommands[0].input.MessageBody)) as Record<string, unknown>;
  assert.equal(dlqBody.reason, "SQS message body does not match claim ingest schema.");
  assert.equal(dlqBody.queueMessage, null);
});

test("worker ignores messages that are missing an SQS receipt handle", async () => {
  const loggedErrorEvents: Array<{ event: string; context: Record<string, unknown> }> = [];
  const commands = createCommandRecorder();

  await handleClaimQueueMessage(
    {
      config: {
        queueUrl: "https://example.invalid/claims",
        dlqUrl: "https://example.invalid/claims-dlq",
        maxReceiveCount: 5,
      },
      sqsClient: commands.client,
      sqsMessage: buildSqsMessage({
        Body: JSON.stringify(buildQueueMessage()),
        ReceiptHandle: undefined,
      }),
    },
    {
      processClaimIngestJobFn: async () => {
        throw new Error("processClaimIngestJob should not run without a receipt handle");
      },
      markClaimAsErrorFn: async () => {
        throw new Error("markClaimAsError should not run without a receipt handle");
      },
      logInfoFn: () => {
        throw new Error("logInfo should not be called without a receipt handle");
      },
      logErrorFn: (event, context) => {
        loggedErrorEvents.push({ event, context });
      },
    },
  );

  assert.deepEqual(
    loggedErrorEvents.map((entry) => entry.event),
    ["queue_message_missing_receipt_handle"],
  );
  assert.equal(commands.sent.length, 0);
});

test("worker uses retryable metadata from WorkerMessageError on processing failures", async () => {
  const commands = createCommandRecorder();
  const loggedErrorEvents: string[] = [];

  await handleClaimQueueMessage(
    {
      config: {
        queueUrl: "https://example.invalid/claims",
        dlqUrl: "https://example.invalid/claims-dlq",
        maxReceiveCount: 5,
      },
      sqsClient: commands.client,
      sqsMessage: buildSqsMessage({
        Body: JSON.stringify(buildQueueMessage()),
        ReceiptHandle: "receipt-retryable",
      }),
    },
    {
      processClaimIngestJobFn: async () => {
        throw new WorkerMessageError("retry later", true);
      },
      markClaimAsErrorFn: async () => {
        throw new Error("markClaimAsError should not run before max receive count");
      },
      logInfoFn: () => {
        throw new Error("logInfo should not be called on failure");
      },
      logErrorFn: (event) => {
        loggedErrorEvents.push(event);
      },
    },
  );

  assert.equal(commands.sent.length, 0);
  assert.deepEqual(loggedErrorEvents, ["claim_ingest_failed_retrying"]);
});

function buildQueueMessage(): ClaimIngestQueueMessage {
  return {
    version: 3,
    claimId: "claim-queue-handler",
    organizationId: "org-queue-handler",
    inboundMessageId: "inbound-queue-handler",
    providerMessageId: "provider-queue-handler",
    enqueuedAt: "2026-03-05T12:00:00.000Z",
    processingAttempt: 1,
    processingLeaseToken: "lease-queue-handler-1",
  };
}

function buildSqsMessage(
  overrides: Partial<{
    MessageId: string;
    Body: string;
    ReceiptHandle: string | undefined;
    Attributes: Record<string, string>;
  }> = {},
): {
  MessageId: string;
  Body: string;
  ReceiptHandle?: string;
  Attributes?: Record<string, string>;
} {
  return {
    MessageId: "sqs-message-queue-handler",
    Body: JSON.stringify(buildQueueMessage()),
    ReceiptHandle: "receipt-default",
    ...overrides,
  };
}

function createCommandRecorder(options: { failDlqPublish?: boolean } = {}): {
  client: {
    send: (command: unknown) => Promise<Record<string, never>>;
  };
  sent: unknown[];
} {
  const sent: unknown[] = [];

  return {
    client: {
      send: async (command) => {
        sent.push(command);

        if (options.failDlqPublish && isCommand(command, "SendMessageCommand")) {
          throw new Error("simulated dlq publish failure");
        }

        return {};
      },
    },
    sent,
  };
}

function isCommand(
  command: unknown,
  name: "DeleteMessageCommand" | "SendMessageCommand" | "ChangeMessageVisibilityCommand",
): command is {
  input: {
    QueueUrl?: string;
    ReceiptHandle?: string;
    MessageBody?: string;
    VisibilityTimeout?: number;
  };
} {
  return (
    typeof command === "object" &&
    command !== null &&
    "constructor" in command &&
    (command as { constructor?: { name?: string } }).constructor?.name === name &&
    "input" in command
  );
}
