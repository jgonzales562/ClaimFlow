import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { extractClaimData, resetOpenAiClientCache } from "../apps/worker/src/extraction.ts";
import { sendClaimIngestQueueMessage, resetSqsClientCache } from "../apps/web/lib/queue/claims.ts";
import { putAttachmentObject, resetS3ClientCache } from "../apps/web/lib/storage/s3.ts";

type FetchInput = Request | string | URL;
type AwsClientWithRegion = {
  config: {
    region: () => Promise<string>;
  };
};
type AwsClientSend = (this: AwsClientWithRegion, command?: unknown) => Promise<unknown>;

const webRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { S3Client } = webRequire("@aws-sdk/client-s3") as {
  S3Client: {
    prototype: {
      send: AwsClientSend;
    };
  };
};
const { SQSClient } = webRequire("@aws-sdk/client-sqs") as {
  SQSClient: {
    prototype: {
      send: AwsClientSend;
    };
  };
};

test("OpenAI extraction client cache is keyed by API key", async () => {
  const originalFetch = globalThis.fetch;
  const seenAuthorizationHeaders: string[] = [];

  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    seenAuthorizationHeaders.push(readAuthorizationHeader(input, init));

    return new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "gpt-test",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                customerName: "Ada Lovelace",
                productName: "Air Purifier",
                serialNumber: "SN-123",
                purchaseDate: "2026-01-15",
                issueSummary: "Unit does not power on.",
                retailer: "Example Store",
                warrantyStatus: "LIKELY_IN_WARRANTY",
                missingInfo: [],
                confidence: 0.96,
                reasoning: "Structured extraction test response.",
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  }) as typeof fetch;

  resetOpenAiClientCache();

  try {
    await extractClaimData(
      {
        providerMessageId: "provider-1",
        fromEmail: "customer@example.com",
        subject: "Warranty claim",
        textBody: "The unit does not power on.",
        strippedTextReply: null,
        claimIssueSummary: null,
        supplementalText: null,
      },
      {
        openAiApiKey: "key-one",
        model: "gpt-test",
        maxInputChars: 2_000,
      },
    );

    await extractClaimData(
      {
        providerMessageId: "provider-2",
        fromEmail: "customer@example.com",
        subject: "Warranty claim",
        textBody: "The unit does not power on.",
        strippedTextReply: null,
        claimIssueSummary: null,
        supplementalText: null,
      },
      {
        openAiApiKey: "key-two",
        model: "gpt-test",
        maxInputChars: 2_000,
      },
    );
  } finally {
    resetOpenAiClientCache();
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(seenAuthorizationHeaders, ["Bearer key-one", "Bearer key-two"]);
});

test("S3 attachment storage reads bucket, prefix, and region from the current env", async () => {
  const originalSend = S3Client.prototype.send;
  const seenCalls: Array<{ region: string; bucket: string; key: string }> = [];

  S3Client.prototype.send = (async function (this: AwsClientWithRegion, command: unknown) {
    seenCalls.push({
      region: await this.config.region(),
      bucket: ((command as { input?: { Bucket?: string } }).input?.Bucket ?? "") as string,
      key: ((command as { input?: { Key?: string } }).input?.Key ?? "") as string,
    });
    return {};
  }) as AwsClientSend;

  resetS3ClientCache();

  try {
    await withEnv(
      {
        AWS_REGION: "us-east-1",
        ATTACHMENTS_S3_BUCKET: "attachments-east",
        ATTACHMENTS_S3_PREFIX: "east-prefix",
      },
      async () => {
        await putAttachmentObject({
          key: "claim-a/receipt.pdf",
          body: Buffer.from("east"),
          contentType: "application/pdf",
        });
      },
    );

    await withEnv(
      {
        AWS_REGION: "us-west-2",
        ATTACHMENTS_S3_BUCKET: "attachments-west",
        ATTACHMENTS_S3_PREFIX: "west-prefix",
      },
      async () => {
        await putAttachmentObject({
          key: "claim-b/receipt.pdf",
          body: Buffer.from("west"),
          contentType: "application/pdf",
        });
      },
    );
  } finally {
    resetS3ClientCache();
    S3Client.prototype.send = originalSend;
  }

  assert.deepEqual(seenCalls, [
    {
      region: "us-east-1",
      bucket: "attachments-east",
      key: "east-prefix/claim-a/receipt.pdf",
    },
    {
      region: "us-west-2",
      bucket: "attachments-west",
      key: "west-prefix/claim-b/receipt.pdf",
    },
  ]);
});

test("SQS queue client cache is keyed by AWS region", async () => {
  const originalSend = SQSClient.prototype.send;
  const seenRegions: string[] = [];

  SQSClient.prototype.send = (async function (this: AwsClientWithRegion) {
    seenRegions.push(await this.config.region());
    return {
      MessageId: "message-id",
    };
  }) as AwsClientSend;

  resetSqsClientCache();

  try {
    await withEnv({ AWS_REGION: "us-east-1" }, async () => {
      await sendClaimIngestQueueMessage({
        queueUrl: "https://example.invalid/claims-east",
        message: {
          version: 3,
          claimId: "claim-east",
          organizationId: "org-east",
          inboundMessageId: "inbound-east",
          providerMessageId: "provider-east",
          enqueuedAt: new Date("2026-04-01T00:00:00.000Z").toISOString(),
          processingAttempt: 1,
          processingLeaseToken: "lease-east",
        },
      });
    });

    await withEnv({ AWS_REGION: "us-west-2" }, async () => {
      await sendClaimIngestQueueMessage({
        queueUrl: "https://example.invalid/claims-west",
        message: {
          version: 3,
          claimId: "claim-west",
          organizationId: "org-west",
          inboundMessageId: "inbound-west",
          providerMessageId: "provider-west",
          enqueuedAt: new Date("2026-04-01T00:00:00.000Z").toISOString(),
          processingAttempt: 1,
          processingLeaseToken: "lease-west",
        },
      });
    });
  } finally {
    resetSqsClientCache();
    SQSClient.prototype.send = originalSend;
  }

  assert.deepEqual(seenRegions, ["us-east-1", "us-west-2"]);
});

function readAuthorizationHeader(input: FetchInput, init?: RequestInit): string {
  if (input instanceof Request) {
    return input.headers.get("authorization") ?? "";
  }

  return new Headers(init?.headers).get("authorization") ?? "";
}

async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const previousValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    previousValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of previousValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
        continue;
      }
      process.env[key] = value;
    }
  }
}
