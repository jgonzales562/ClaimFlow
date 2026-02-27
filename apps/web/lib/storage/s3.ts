import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

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
