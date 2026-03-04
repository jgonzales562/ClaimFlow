import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

type PutAttachmentObjectInput = {
  key: string;
  body: Buffer;
  contentType: string | null;
  metadata?: Record<string, string>;
};

type AttachmentStorageConfig = {
  bucket: string;
  prefix: string;
};

type SignedAttachmentAccessInput = {
  bucket: string;
  key: string;
  filename: string;
  contentType: string | null;
  expiresInSeconds?: number;
  disposition?: "attachment" | "inline";
};

let clientSingleton: S3Client | undefined;

export async function putAttachmentObject(input: PutAttachmentObjectInput): Promise<{
  bucket: string;
  key: string;
}> {
  const config = getAttachmentStorageConfig();
  const client = getS3Client();

  const fullKey = config.prefix ? `${config.prefix}/${input.key}` : input.key;

  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: fullKey,
      Body: input.body,
      ContentType: input.contentType ?? "application/octet-stream",
      Metadata: input.metadata,
    }),
  );

  return {
    bucket: config.bucket,
    key: fullKey,
  };
}

export async function createSignedAttachmentAccessUrl(
  input: SignedAttachmentAccessInput,
): Promise<string> {
  const client = getS3Client();
  const expiresIn = clampSignedUrlTtlSeconds(input.expiresInSeconds ?? 300);
  const filename = sanitizeFilenameForContentDisposition(input.filename);
  const disposition = input.disposition ?? "attachment";
  const command = new GetObjectCommand({
    Bucket: input.bucket,
    Key: input.key,
    ResponseContentType: input.contentType ?? "application/octet-stream",
    ResponseContentDisposition: `${disposition}; filename="${filename}"`,
  });

  // pnpm can install parallel Smithy type trees across AWS SDK packages.
  // Runtime is compatible; bridge types for getSignedUrl.
  const signerClient = client as unknown as Parameters<typeof getSignedUrl>[0];
  const signerCommand = command as unknown as Parameters<typeof getSignedUrl>[1];
  return getSignedUrl(signerClient, signerCommand, { expiresIn });
}

function getS3Client(): S3Client {
  if (clientSingleton) {
    return clientSingleton;
  }

  const region = process.env.AWS_REGION?.trim();
  if (!region) {
    throw new Error("AWS_REGION is required to upload attachments to S3.");
  }

  clientSingleton = new S3Client({ region });
  return clientSingleton;
}

function getAttachmentStorageConfig(): AttachmentStorageConfig {
  const bucket = process.env.ATTACHMENTS_S3_BUCKET?.trim();
  if (!bucket) {
    throw new Error("ATTACHMENTS_S3_BUCKET is required to upload attachments.");
  }

  const prefix = process.env.ATTACHMENTS_S3_PREFIX?.trim() ?? "claimflow";

  return {
    bucket,
    prefix: trimSlashes(prefix),
  };
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function clampSignedUrlTtlSeconds(value: number): number {
  if (!Number.isFinite(value)) {
    return 300;
  }

  return Math.min(Math.max(Math.floor(value), 60), 3600);
}

function sanitizeFilenameForContentDisposition(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "attachment.bin";
  }

  return trimmed.replace(/["\r\n]/g, "_").slice(0, 180);
}
