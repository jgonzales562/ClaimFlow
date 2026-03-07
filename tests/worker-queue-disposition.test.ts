import assert from "node:assert/strict";
import { test } from "node:test";
import {
  handleQueueProcessingFailure,
  type ClaimIngestQueueMessage,
} from "../apps/worker/src/queue-disposition.ts";

test("worker failure moves retryable messages to the DLQ after the max receive count", async () => {
  const queueMessage = buildQueueMessage();
  const markClaimAsErrorCalls: Array<Record<string, unknown>> = [];
  const loggedEvents: string[] = [];
  const commands = createCommandRecorder();

  const result = await handleQueueProcessingFailure(
    {
      config: {
        queueUrl: "https://example.invalid/claims",
        dlqUrl: "https://example.invalid/claims-dlq",
        maxReceiveCount: 3,
      },
      sqsClient: commands.client,
      sqsMessage: buildSqsMessage(),
      receiptHandle: "receipt-handle-1",
      receiveCount: 3,
      reason: "transient downstream failure",
      retryable: true,
      queueMessage,
    },
    {
      markClaimAsErrorFn: async (input) => {
        markClaimAsErrorCalls.push(input);
      },
      logErrorFn: (event) => {
        loggedEvents.push(event);
      },
      nowFn: () => new Date("2026-03-05T12:00:00.000Z"),
    },
  );

  assert.equal(result, "moved_to_dlq");
  assert.deepEqual(markClaimAsErrorCalls, [
    {
      claimId: queueMessage.claimId,
      organizationId: queueMessage.organizationId,
      reason: "transient downstream failure",
      retryable: true,
      receiveCount: 3,
      failureDisposition: "moved_to_dlq",
    },
  ]);
  assert.deepEqual(loggedEvents, ["claim_ingest_moved_to_dlq"]);

  const sendCommands = commands.sent.filter((command) => isCommand(command, "SendMessageCommand"));
  const deleteCommands = commands.sent.filter((command) =>
    isCommand(command, "DeleteMessageCommand"),
  );

  assert.equal(sendCommands.length, 1);
  assert.equal(deleteCommands.length, 1);
  assert.equal(sendCommands[0].input.QueueUrl, "https://example.invalid/claims-dlq");
  assert.equal(deleteCommands[0].input.QueueUrl, "https://example.invalid/claims");
  assert.equal(deleteCommands[0].input.ReceiptHandle, "receipt-handle-1");

  const dlqBody = JSON.parse(String(sendCommands[0].input.MessageBody)) as Record<string, unknown>;
  assert.deepEqual(dlqBody, {
    failedAt: "2026-03-05T12:00:00.000Z",
    reason: "transient downstream failure",
    retryable: true,
    receiveCount: 3,
    queueMessage,
    originalMessageId: "message-1",
    originalBody: '{"version":1}',
  });
});

test("worker failure drops non-retryable messages when no DLQ is configured", async () => {
  const queueMessage = buildQueueMessage();
  const markClaimAsErrorCalls: Array<Record<string, unknown>> = [];
  const loggedEvents: string[] = [];
  const commands = createCommandRecorder();

  const result = await handleQueueProcessingFailure(
    {
      config: {
        queueUrl: "https://example.invalid/claims",
        dlqUrl: null,
        maxReceiveCount: 5,
      },
      sqsClient: commands.client,
      sqsMessage: buildSqsMessage(),
      receiptHandle: "receipt-handle-2",
      receiveCount: 1,
      reason: "invalid message payload",
      retryable: false,
      queueMessage,
    },
    {
      markClaimAsErrorFn: async (input) => {
        markClaimAsErrorCalls.push(input);
      },
      logErrorFn: (event) => {
        loggedEvents.push(event);
      },
    },
  );

  assert.equal(result, "dropped_non_retryable");
  assert.deepEqual(markClaimAsErrorCalls, [
    {
      claimId: queueMessage.claimId,
      organizationId: queueMessage.organizationId,
      reason: "invalid message payload",
      retryable: false,
      receiveCount: 1,
      failureDisposition: "dropped_non_retryable",
    },
  ]);
  assert.deepEqual(loggedEvents, ["claim_ingest_dropped_non_retryable"]);

  const deleteCommands = commands.sent.filter((command) =>
    isCommand(command, "DeleteMessageCommand"),
  );
  assert.equal(deleteCommands.length, 1);
  assert.equal(deleteCommands[0].input.QueueUrl, "https://example.invalid/claims");
});

test("worker failure leaves retryable messages on the queue before the max receive count", async () => {
  const loggedEvents: string[] = [];
  const commands = createCommandRecorder();
  const markClaimAsErrorCalls: Array<Record<string, unknown>> = [];

  const result = await handleQueueProcessingFailure(
    {
      config: {
        queueUrl: "https://example.invalid/claims",
        dlqUrl: "https://example.invalid/claims-dlq",
        maxReceiveCount: 4,
      },
      sqsClient: commands.client,
      sqsMessage: buildSqsMessage(),
      receiptHandle: "receipt-handle-3",
      receiveCount: 2,
      reason: "temporary outage",
      retryable: true,
      queueMessage: buildQueueMessage(),
    },
    {
      markClaimAsErrorFn: async (input) => {
        markClaimAsErrorCalls.push(input);
      },
      logErrorFn: (event) => {
        loggedEvents.push(event);
      },
    },
  );

  assert.equal(result, "retrying");
  assert.equal(commands.sent.length, 0);
  assert.equal(markClaimAsErrorCalls.length, 0);
  assert.deepEqual(loggedEvents, ["claim_ingest_failed_retrying"]);
});

test("worker failure retains the source message when DLQ publishing fails", async () => {
  const loggedEvents: string[] = [];
  const commands = createCommandRecorder({ failDlqPublish: true });
  const markClaimAsErrorCalls: Array<Record<string, unknown>> = [];

  const result = await handleQueueProcessingFailure(
    {
      config: {
        queueUrl: "https://example.invalid/claims",
        dlqUrl: "https://example.invalid/claims-dlq",
        maxReceiveCount: 5,
      },
      sqsClient: commands.client,
      sqsMessage: buildSqsMessage(),
      receiptHandle: "receipt-handle-4",
      receiveCount: 1,
      reason: "permanent downstream failure",
      retryable: false,
      queueMessage: buildQueueMessage(),
    },
    {
      markClaimAsErrorFn: async (input) => {
        markClaimAsErrorCalls.push(input);
      },
      logErrorFn: (event) => {
        loggedEvents.push(event);
      },
    },
  );

  assert.equal(result, "retrying");
  assert.equal(markClaimAsErrorCalls.length, 0);
  assert.deepEqual(loggedEvents, ["queue_dlq_publish_failed", "claim_ingest_failed_retrying"]);

  const sendCommands = commands.sent.filter((command) => isCommand(command, "SendMessageCommand"));
  const deleteCommands = commands.sent.filter((command) =>
    isCommand(command, "DeleteMessageCommand"),
  );

  assert.equal(sendCommands.length, 1);
  assert.equal(deleteCommands.length, 0);
});

test("worker failure releases the processing lease before retrying a version 3 message", async () => {
  const queueMessage: ClaimIngestQueueMessage = {
    version: 3,
    claimId: "claim-lease-1",
    organizationId: "org-lease-1",
    inboundMessageId: "inbound-lease-1",
    providerMessageId: "provider-lease-1",
    enqueuedAt: "2026-03-05T11:59:00.000Z",
    processingAttempt: 2,
    processingLeaseToken: "lease-token-2",
  };
  const loggedEvents: string[] = [];
  const loggedInfo: Array<{ event: string; context: Record<string, unknown> }> = [];
  const releaseCalls: Array<Record<string, unknown>> = [];
  const commands = createCommandRecorder();

  const result = await handleQueueProcessingFailure(
    {
      config: {
        queueUrl: "https://example.invalid/claims",
        dlqUrl: "https://example.invalid/claims-dlq",
        maxReceiveCount: 4,
      },
      sqsClient: commands.client,
      sqsMessage: buildSqsMessage(),
      receiptHandle: "receipt-handle-lease",
      receiveCount: 2,
      reason: "temporary outage",
      retryable: true,
      queueMessage,
    },
    {
      markClaimAsErrorFn: async () => {},
      releaseClaimProcessingLeaseFn: async (input) => {
        releaseCalls.push(input);
      },
      logInfoFn: (event, context) => {
        loggedInfo.push({ event, context });
      },
      logErrorFn: (event) => {
        loggedEvents.push(event);
      },
    },
  );

  assert.equal(result, "retrying");
  assert.equal(commands.sent.length, 0);
  assert.deepEqual(releaseCalls, [
    {
      claimId: "claim-lease-1",
      organizationId: "org-lease-1",
      processingAttempt: 2,
      processingLeaseToken: "lease-token-2",
    },
  ]);
  assert.deepEqual(loggedEvents, ["claim_ingest_failed_retrying"]);
  assert.deepEqual(loggedInfo, [
    {
      event: "claim_processing_lease_released",
      context: {
        claimId: "claim-lease-1",
        organizationId: "org-lease-1",
        processingAttempt: 2,
        processingLeaseToken: "lease-token-2",
        receiveCount: 2,
        reason: "temporary outage",
      },
    },
  ]);
});

function buildQueueMessage(): ClaimIngestQueueMessage {
  return {
    version: 1,
    claimId: "claim-1",
    organizationId: "org-1",
    inboundMessageId: "inbound-1",
    providerMessageId: "provider-1",
    enqueuedAt: "2026-03-05T11:59:00.000Z",
  };
}

function buildSqsMessage(): {
  MessageId: string;
  Body: string;
} {
  return {
    MessageId: "message-1",
    Body: '{"version":1}',
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

function isCommand(command: unknown, name: "DeleteMessageCommand" | "SendMessageCommand"): command is {
  input: {
    QueueUrl?: string;
    ReceiptHandle?: string;
    MessageBody?: string;
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
