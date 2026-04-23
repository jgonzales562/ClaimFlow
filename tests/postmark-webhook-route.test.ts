import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { POST } from "../apps/web/app/api/webhooks/postmark/inbound/route.ts";
import { createPostmarkInboundHandler } from "../apps/web/lib/postmark/inbound-webhook.ts";
import { prisma } from "../packages/db/src/index.ts";

after(async () => {
  await prisma.$disconnect();
});

test("postmark webhook rejects unauthorized requests", async () => {
  await withEnv(
    {
      POSTMARK_WEBHOOK_BASIC_AUTH_USER: "route-test-user",
      POSTMARK_WEBHOOK_BASIC_AUTH_PASS: "route-test-pass",
    },
    async () => {
      const response = await POST(
        new Request("http://localhost/api/webhooks/postmark/inbound", {
          method: "POST",
          body: JSON.stringify({ MessageID: `message-${randomUUID()}` }),
          headers: {
            "content-type": "application/json",
          },
        }),
      );

      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "Forbidden" });
    },
  );
});

test("postmark webhook fails closed when auth credentials are not configured", async () => {
  await withEnv(
    {
      POSTMARK_WEBHOOK_BASIC_AUTH_USER: undefined,
      POSTMARK_WEBHOOK_BASIC_AUTH_PASS: undefined,
    },
    async () => {
      const response = await POST(
        new Request("http://localhost/api/webhooks/postmark/inbound", {
          method: "POST",
          body: JSON.stringify({ MessageID: `message-${randomUUID()}` }),
          headers: {
            "content-type": "application/json",
          },
        }),
      );

      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "Service unavailable" });
    },
  );
});

test("postmark webhook uses the default org fallback only when explicitly enabled", async () => {
  const suffix = randomUUID();
  const providerMessageId = `message-${suffix}`;
  const authHeader = `Basic ${Buffer.from("route-test-user:route-test-pass").toString("base64")}`;

  await withEnv(
    {
      NODE_ENV: "test",
      POSTMARK_WEBHOOK_BASIC_AUTH_USER: "route-test-user",
      POSTMARK_WEBHOOK_BASIC_AUTH_PASS: "route-test-pass",
      POSTMARK_DEFAULT_ORG_SLUG: `webhook-fallback-${suffix}`,
      POSTMARK_ALLOW_DEFAULT_ORG_FALLBACK: "true",
    },
    async () => {
      const handler = createPostmarkInboundHandler({
        prismaClient: prisma,
        maybeEnqueueClaimForProcessingFn: async () => ({
          reason: "queue_not_configured",
        }),
      });

      const organization = await prisma.organization.create({
        data: {
          name: `Webhook Fallback Test ${suffix}`,
          slug: `webhook-fallback-${suffix}`,
        },
        select: {
          id: true,
        },
      });

      try {
        const response = await handler(
          new Request("http://localhost/api/webhooks/postmark/inbound", {
            method: "POST",
            body: JSON.stringify({
              MessageID: providerMessageId,
              From: `Customer <customer-${suffix}@example.com>`,
              To: `claims+${suffix}@example.com`,
              Subject: "Fallback org routing",
              TextBody: "No mailbox hash was provided.",
            }),
            headers: {
              authorization: authHeader,
              "content-type": "application/json",
            },
          }),
        );

        assert.equal(response.status, 200);

        const body = (await response.json()) as Record<string, unknown>;
        assert.equal(body.organizationId, organization.id);
        assert.equal(body.claimStatus, "NEW");
      } finally {
        await prisma.organization.delete({
          where: {
            id: organization.id,
          },
        });
      }
    },
  );
});

test("postmark webhook rejects unresolved orgs when the default fallback is not enabled", async () => {
  const suffix = randomUUID();
  const authHeader = `Basic ${Buffer.from("route-test-user:route-test-pass").toString("base64")}`;

  await withEnv(
    {
      NODE_ENV: "production",
      POSTMARK_WEBHOOK_BASIC_AUTH_USER: "route-test-user",
      POSTMARK_WEBHOOK_BASIC_AUTH_PASS: "route-test-pass",
      POSTMARK_DEFAULT_ORG_SLUG: `webhook-fallback-disabled-${suffix}`,
      POSTMARK_ALLOW_DEFAULT_ORG_FALLBACK: undefined,
    },
    async () => {
      const handler = createPostmarkInboundHandler({
        prismaClient: prisma,
      });

      const organization = await prisma.organization.create({
        data: {
          name: `Webhook Disabled Fallback Test ${suffix}`,
          slug: `webhook-fallback-disabled-${suffix}`,
        },
        select: {
          id: true,
        },
      });

      try {
        const response = await handler(
          new Request("http://localhost/api/webhooks/postmark/inbound", {
            method: "POST",
            body: JSON.stringify({
              MessageID: `message-${suffix}`,
              From: `Customer <customer-${suffix}@example.com>`,
              To: `claims+${suffix}@example.com`,
              Subject: "Fallback disabled",
              TextBody: "No mailbox hash was provided.",
            }),
            headers: {
              authorization: authHeader,
              "content-type": "application/json",
            },
          }),
        );

        assert.equal(response.status, 422);
        assert.deepEqual(await response.json(), {
          error: "Unable to resolve organization for inbound message",
        });
      } finally {
        await prisma.organization.delete({
          where: {
            id: organization.id,
          },
        });
      }
    },
  );
});

test("postmark webhook returns deduplicated response for existing inbound messages", async () => {
  const suffix = randomUUID();
  const mailboxHash = `mailbox-${suffix}`;
  const providerMessageId = `message-${suffix}`;
  const authHeader = `Basic ${Buffer.from("route-test-user:route-test-pass").toString("base64")}`;
  const revalidatedOrganizations: string[] = [];

  await withEnv(
    {
      POSTMARK_WEBHOOK_BASIC_AUTH_USER: "route-test-user",
      POSTMARK_WEBHOOK_BASIC_AUTH_PASS: "route-test-pass",
    },
    async () => {
      const organization = await prisma.organization.create({
        data: {
          name: `Webhook Route Test ${suffix}`,
          slug: `webhook-route-test-${suffix}`,
          integrationMailbox: {
            create: {
              provider: "POSTMARK",
              mailboxHash,
              emailAddress: `claims+${suffix}@example.com`,
            },
          },
        },
        select: {
          id: true,
        },
      });

      const handler = createPostmarkInboundHandler({
        prismaClient: prisma,
        revalidateDashboardSummaryCacheFn: (organizationId) => {
          revalidatedOrganizations.push(organizationId);
        },
      });

      try {
        const claim = await prisma.claim.create({
          data: {
            organizationId: organization.id,
            externalClaimId: `claim-${suffix}`,
            sourceEmail: `customer-${suffix}@example.com`,
            issueSummary: "Duplicate claim test",
            status: "PROCESSING",
          },
          select: {
            id: true,
          },
        });

        const existingMessage = await prisma.inboundMessage.create({
          data: {
            organizationId: organization.id,
            provider: "POSTMARK",
            providerMessageId,
            mailboxHash,
            fromEmail: `customer-${suffix}@example.com`,
            toEmail: `claims+${suffix}@example.com`,
            subject: "Help with warranty claim",
            rawPayload: { seeded: true },
            claimId: claim.id,
          },
          select: {
            id: true,
            createdAt: true,
          },
        });

        const response = await handler(
          new Request("http://localhost/api/webhooks/postmark/inbound", {
            method: "POST",
            body: JSON.stringify({
              MessageID: providerMessageId,
              MailboxHash: mailboxHash,
              From: `Customer <customer-${suffix}@example.com>`,
              To: `claims+${suffix}@example.com`,
              Subject: "Help with warranty claim",
              TextBody: "This is a duplicate message.",
            }),
            headers: {
              authorization: authHeader,
              "content-type": "application/json",
            },
          }),
        );

        assert.equal(response.status, 200);

        const body = (await response.json()) as Record<string, unknown>;
        assert.equal(body.ok, true);
        assert.equal(body.deduplicated, true);
        assert.equal(body.claimId, claim.id);
        assert.equal(body.messageId, existingMessage.id);
        assert.equal(body.claimStatus, "PROCESSING");
        assert.equal(body.queue, null);
        assert.equal(body.receivedAt, existingMessage.createdAt.toISOString());

        const messages = await prisma.inboundMessage.findMany({
          where: {
            organizationId: organization.id,
            providerMessageId,
          },
          select: {
            id: true,
            rawPayloadSchemaVersion: true,
          },
        });

        assert.equal(messages.length, 1);
        assert.equal(messages[0]?.rawPayloadSchemaVersion, 1);
        assert.deepEqual(revalidatedOrganizations, []);
      } finally {
        await prisma.organization.delete({
          where: {
            id: organization.id,
          },
        });
      }
    },
  );
});

test("postmark webhook persists stored attachments and returns attachment counts", async () => {
  const suffix = randomUUID();
  const mailboxHash = `mailbox-${suffix}`;
  const providerMessageId = `message-${suffix}`;
  const authHeader = `Basic ${Buffer.from("route-test-user:route-test-pass").toString("base64")}`;
  const storedObjects: Array<{
    key: string;
    contentType: string | null;
    metadata: Record<string, string> | undefined;
    body: string;
  }> = [];
  const revalidatedOrganizations: string[] = [];

  await withEnv(
    {
      POSTMARK_WEBHOOK_BASIC_AUTH_USER: "route-test-user",
      POSTMARK_WEBHOOK_BASIC_AUTH_PASS: "route-test-pass",
    },
    async () => {
      const handler = createPostmarkInboundHandler({
        prismaClient: prisma,
        maybeEnqueueClaimForProcessingFn: async () => ({
          reason: "queue_not_configured",
        }),
        revalidateDashboardSummaryCacheFn: (organizationId) => {
          revalidatedOrganizations.push(organizationId);
        },
        putAttachmentObjectFn: async (input) => {
          storedObjects.push({
            key: input.key,
            contentType: input.contentType,
            metadata: input.metadata,
            body: input.body.toString("utf8"),
          });

          return {
            bucket: "test-bucket",
            key: `test-prefix/${input.key}`,
          };
        },
      });

      const organization = await prisma.organization.create({
        data: {
          name: `Webhook Attachment Test ${suffix}`,
          slug: `webhook-attachment-test-${suffix}`,
          integrationMailbox: {
            create: {
              provider: "POSTMARK",
              mailboxHash,
              emailAddress: `claims+${suffix}@example.com`,
            },
          },
        },
        select: {
          id: true,
        },
      });

      try {
        const response = await handler(
          new Request("http://localhost/api/webhooks/postmark/inbound", {
            method: "POST",
            body: JSON.stringify({
              MessageID: providerMessageId,
              MailboxHash: mailboxHash,
              From: `Customer <customer-${suffix}@example.com>`,
              To: `claims+${suffix}@example.com`,
              Subject: "Need warranty help",
              TextBody: "Attachment included.",
              Attachments: [
                {
                  Name: "receipt.pdf",
                  Content: Buffer.from("hello").toString("base64"),
                  ContentType: "application/pdf",
                  ContentLength: 5,
                },
              ],
            }),
            headers: {
              authorization: authHeader,
              "content-type": "application/json",
            },
          }),
        );

        assert.equal(response.status, 200);
        const body = (await response.json()) as Record<string, unknown>;
        assert.equal(body.ok, true);
        assert.equal(body.deduplicated, false);
        assert.equal(body.claimStatus, "NEW");
        assert.deepEqual(body.queue, {
          reason: "queue_not_configured",
        });
        assert.deepEqual(body.attachments, {
          received: 1,
          stored: 1,
          failed: 0,
          errors: [],
        });

        assert.equal(storedObjects.length, 1);
        assert.equal(storedObjects[0]?.body, "hello");
        assert.equal(storedObjects[0]?.contentType, "application/pdf");
        assert.equal(storedObjects[0]?.metadata?.provider_message_id, providerMessageId);
        assert.equal(typeof storedObjects[0]?.metadata?.claim_id, "string");
        assert.equal(typeof storedObjects[0]?.metadata?.inbound_message_id, "string");
        assert.match(
          storedObjects[0]?.key ?? "",
          /^orgs\/.+\/claims\/.+\/messages\/.+\/.+-receipt\.pdf$/,
        );
        assert.deepEqual(revalidatedOrganizations, [organization.id]);

        const attachments = await prisma.claimAttachment.findMany({
          where: {
            organizationId: organization.id,
          },
          select: {
            uploadStatus: true,
            originalFilename: true,
            contentType: true,
            byteSize: true,
            s3Bucket: true,
            s3Key: true,
          },
        });

        assert.equal(attachments.length, 1);
        assert.equal(attachments[0]?.uploadStatus, "STORED");
        assert.equal(attachments[0]?.originalFilename, "receipt.pdf");
        assert.equal(attachments[0]?.contentType, "application/pdf");
        assert.equal(attachments[0]?.byteSize, 5);
        assert.equal(attachments[0]?.s3Bucket, "test-bucket");
        assert.match(
          attachments[0]?.s3Key ?? "",
          /^test-prefix\/orgs\/.+\/claims\/.+\/messages\/.+\/.+-receipt\.pdf$/,
        );
      } finally {
        await prisma.organization.delete({
          where: {
            id: organization.id,
          },
        });
      }
    },
  );
});

test("postmark webhook rejects malformed attachment base64 and records the attachment as failed", async () => {
  const suffix = randomUUID();
  const mailboxHash = `mailbox-${suffix}`;
  const providerMessageId = `message-${suffix}`;
  const authHeader = `Basic ${Buffer.from("route-test-user:route-test-pass").toString("base64")}`;
  const storedObjects: Array<{ key: string }> = [];

  await withEnv(
    {
      POSTMARK_WEBHOOK_BASIC_AUTH_USER: "route-test-user",
      POSTMARK_WEBHOOK_BASIC_AUTH_PASS: "route-test-pass",
    },
    async () => {
      const handler = createPostmarkInboundHandler({
        prismaClient: prisma,
        maybeEnqueueClaimForProcessingFn: async () => ({
          reason: "queue_not_configured",
        }),
        putAttachmentObjectFn: async (input) => {
          storedObjects.push({ key: input.key });
          return {
            bucket: "test-bucket",
            key: `test-prefix/${input.key}`,
          };
        },
      });

      const organization = await prisma.organization.create({
        data: {
          name: `Webhook Invalid Attachment Test ${suffix}`,
          slug: `webhook-invalid-attachment-test-${suffix}`,
          integrationMailbox: {
            create: {
              provider: "POSTMARK",
              mailboxHash,
              emailAddress: `claims+${suffix}@example.com`,
            },
          },
        },
        select: {
          id: true,
        },
      });

      try {
        const response = await handler(
          new Request("http://localhost/api/webhooks/postmark/inbound", {
            method: "POST",
            body: JSON.stringify({
              MessageID: providerMessageId,
              MailboxHash: mailboxHash,
              From: `Customer <customer-${suffix}@example.com>`,
              To: `claims+${suffix}@example.com`,
              Subject: "Malformed attachment payload",
              TextBody: "Attachment included.",
              Attachments: [
                {
                  Name: "receipt.pdf",
                  Content: "not-base64",
                  ContentType: "application/pdf",
                  ContentLength: 10,
                },
              ],
            }),
            headers: {
              authorization: authHeader,
              "content-type": "application/json",
            },
          }),
        );

        assert.equal(response.status, 200);
        const body = (await response.json()) as Record<string, unknown>;
        assert.equal(body.ok, true);
        assert.deepEqual(body.attachments, {
          received: 1,
          stored: 0,
          failed: 1,
          errors: [
            {
              filename: "receipt.pdf",
              message: "Attachment content is not valid base64.",
            },
          ],
        });

        assert.equal(storedObjects.length, 0);

        const attachments = await prisma.claimAttachment.findMany({
          where: {
            organizationId: organization.id,
          },
          select: {
            uploadStatus: true,
            originalFilename: true,
            byteSize: true,
            errorMessage: true,
          },
        });

        assert.equal(attachments.length, 1);
        assert.equal(attachments[0]?.uploadStatus, "FAILED");
        assert.equal(attachments[0]?.originalFilename, "receipt.pdf");
        assert.equal(attachments[0]?.byteSize, 10);
        assert.equal(attachments[0]?.errorMessage, "Attachment content is not valid base64.");
      } finally {
        await prisma.organization.delete({
          where: {
            id: organization.id,
          },
        });
      }
    },
  );
});

test("postmark webhook persists mixed attachment outcomes in one request", async () => {
  const suffix = randomUUID();
  const mailboxHash = `mailbox-${suffix}`;
  const providerMessageId = `message-${suffix}`;
  const authHeader = `Basic ${Buffer.from("route-test-user:route-test-pass").toString("base64")}`;
  const storedObjects: Array<{ key: string; body: string }> = [];

  await withEnv(
    {
      POSTMARK_WEBHOOK_BASIC_AUTH_USER: "route-test-user",
      POSTMARK_WEBHOOK_BASIC_AUTH_PASS: "route-test-pass",
    },
    async () => {
      const handler = createPostmarkInboundHandler({
        prismaClient: prisma,
        maybeEnqueueClaimForProcessingFn: async () => ({
          reason: "queue_not_configured",
        }),
        putAttachmentObjectFn: async (input) => {
          storedObjects.push({
            key: input.key,
            body: Buffer.from(input.body).toString("utf8"),
          });
          return {
            bucket: "test-bucket",
            key: `test-prefix/${input.key}`,
          };
        },
      });

      const organization = await prisma.organization.create({
        data: {
          name: `Webhook Mixed Attachment Test ${suffix}`,
          slug: `webhook-mixed-attachment-test-${suffix}`,
          integrationMailbox: {
            create: {
              provider: "POSTMARK",
              mailboxHash,
              emailAddress: `claims+${suffix}@example.com`,
            },
          },
        },
        select: {
          id: true,
        },
      });

      try {
        const response = await handler(
          new Request("http://localhost/api/webhooks/postmark/inbound", {
            method: "POST",
            body: JSON.stringify({
              MessageID: providerMessageId,
              MailboxHash: mailboxHash,
              From: `Customer <customer-${suffix}@example.com>`,
              To: `claims+${suffix}@example.com`,
              Subject: "Mixed attachment payload",
              TextBody: "Three attachments included.",
              Attachments: [
                {
                  Name: "receipt.pdf",
                  Content: Buffer.from("hello").toString("base64"),
                  ContentType: "application/pdf",
                  ContentLength: 5,
                },
                {
                  Name: "broken.txt",
                  Content: "not-base64",
                  ContentType: "text/plain",
                  ContentLength: 10,
                },
                {
                  Name: "serial.txt",
                  Content: Buffer.from("serial-123").toString("base64"),
                  ContentType: "text/plain",
                  ContentLength: 10,
                },
              ],
            }),
            headers: {
              authorization: authHeader,
              "content-type": "application/json",
            },
          }),
        );

        assert.equal(response.status, 200);
        const body = (await response.json()) as Record<string, unknown>;
        assert.deepEqual(body.attachments, {
          received: 3,
          stored: 2,
          failed: 1,
          errors: [
            {
              filename: "broken.txt",
              message: "Attachment content is not valid base64.",
            },
          ],
        });

        assert.equal(storedObjects.length, 2);
        assert.deepEqual(storedObjects.map((object) => object.body).sort(), [
          "hello",
          "serial-123",
        ]);

        const attachments = await prisma.claimAttachment.findMany({
          where: {
            organizationId: organization.id,
          },
          orderBy: [{ originalFilename: "asc" }],
          select: {
            uploadStatus: true,
            originalFilename: true,
            byteSize: true,
            errorMessage: true,
          },
        });

        assert.deepEqual(
          attachments.map((attachment) => ({
            uploadStatus: attachment.uploadStatus,
            originalFilename: attachment.originalFilename,
            byteSize: attachment.byteSize,
            errorMessage: attachment.errorMessage,
          })),
          [
            {
              uploadStatus: "FAILED",
              originalFilename: "broken.txt",
              byteSize: 10,
              errorMessage: "Attachment content is not valid base64.",
            },
            {
              uploadStatus: "STORED",
              originalFilename: "receipt.pdf",
              byteSize: 5,
              errorMessage: null,
            },
            {
              uploadStatus: "STORED",
              originalFilename: "serial.txt",
              byteSize: 10,
              errorMessage: null,
            },
          ],
        );
      } finally {
        await prisma.organization.delete({
          where: {
            id: organization.id,
          },
        });
      }
    },
  );
});

test("postmark webhook accepts persisted claims when immediate dispatch is deferred", async () => {
  const suffix = randomUUID();
  const mailboxHash = `mailbox-${suffix}`;
  const providerMessageId = `message-${suffix}`;
  const authHeader = `Basic ${Buffer.from("route-test-user:route-test-pass").toString("base64")}`;
  const revalidatedOrganizations: string[] = [];

  await withEnv(
    {
      POSTMARK_WEBHOOK_BASIC_AUTH_USER: "route-test-user",
      POSTMARK_WEBHOOK_BASIC_AUTH_PASS: "route-test-pass",
    },
    async () => {
      const handler = createPostmarkInboundHandler({
        prismaClient: prisma,
        maybeEnqueueClaimForProcessingFn: async (input) => {
          if (input.claimId) {
            await prisma.claim.update({
              where: {
                id: input.claimId,
              },
              data: {
                status: "PROCESSING",
              },
            });
          }

          return {
            scheduled: true,
            queueUrl: "https://example.invalid/claims",
            messageId: `queue-${suffix}`,
            dispatchState: "deferred" as const,
            sqsMessageId: null,
            error: "simulated queue failure",
          };
        },
        revalidateDashboardSummaryCacheFn: (organizationId) => {
          revalidatedOrganizations.push(organizationId);
        },
      });

      const organization = await prisma.organization.create({
        data: {
          name: `Webhook Queue Failure Test ${suffix}`,
          slug: `webhook-queue-failure-test-${suffix}`,
          integrationMailbox: {
            create: {
              provider: "POSTMARK",
              mailboxHash,
              emailAddress: `claims+${suffix}@example.com`,
            },
          },
        },
        select: {
          id: true,
        },
      });

      try {
        const response = await handler(
          new Request("http://localhost/api/webhooks/postmark/inbound", {
            method: "POST",
            body: JSON.stringify({
              MessageID: providerMessageId,
              MailboxHash: mailboxHash,
              From: `Customer <customer-${suffix}@example.com>`,
              To: `claims+${suffix}@example.com`,
              Subject: "Queue failure case",
              TextBody: "This should persist before the enqueue failure.",
            }),
            headers: {
              authorization: authHeader,
              "content-type": "application/json",
            },
          }),
        );

        assert.equal(response.status, 200);

        const inboundMessages = await prisma.inboundMessage.findMany({
          where: {
            organizationId: organization.id,
            providerMessageId,
          },
          select: {
            id: true,
            claimId: true,
            rawPayloadSchemaVersion: true,
          },
        });

        assert.equal(inboundMessages.length, 1);
        assert.equal(typeof inboundMessages[0]?.claimId, "string");
        assert.equal(inboundMessages[0]?.rawPayloadSchemaVersion, 1);

        const claims = await prisma.claim.findMany({
          where: {
            organizationId: organization.id,
            externalClaimId: `postmark:${providerMessageId}`,
          },
          select: {
            id: true,
            status: true,
            events: {
              select: {
                id: true,
              },
            },
          },
        });

        assert.equal(claims.length, 1);
        assert.equal(claims[0]?.status, "PROCESSING");
        assert.equal(claims[0]?.events.length, 0);
        assert.deepEqual(revalidatedOrganizations, [organization.id]);

        assert.deepEqual(await response.json(), {
          ok: true,
          deduplicated: false,
          organizationId: organization.id,
          claimId: claims[0]?.id,
          claimStatus: "PROCESSING",
          messageId: inboundMessages[0]?.id,
          attachments: {
            received: 0,
            stored: 0,
            failed: 0,
            errors: [],
          },
          queue: {
            scheduled: true,
            queueUrl: "https://example.invalid/claims",
            messageId: `queue-${suffix}`,
            dispatchState: "deferred",
            sqsMessageId: null,
            error: "simulated queue failure",
          },
        });
      } finally {
        await prisma.organization.delete({
          where: {
            id: organization.id,
          },
        });
      }
    },
  );
});

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
