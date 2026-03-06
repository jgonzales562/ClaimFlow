import { DetectDocumentTextCommand, TextractClient } from "@aws-sdk/client-textract";
import { extractErrorMessage } from "./errors.js";
import { truncateString } from "./strings.js";

type StoredAttachment = {
  id: string;
  originalFilename: string;
  contentType: string | null;
  s3Bucket: string;
  s3Key: string;
};

type TextractFallbackConfig = {
  enabled: boolean;
  maxAttachments: number;
  maxTextChars: number;
};

type TextractFallbackResult = {
  attempted: boolean;
  text: string | null;
  attachmentsConsidered: number;
  attachmentsProcessed: number;
  skipped: Array<{ attachmentId: string; reason: string }>;
  failed: Array<{ attachmentId: string; reason: string }>;
};

let textractClientSingleton: TextractClient | undefined;

export async function extractAttachmentTextWithTextract(input: {
  region: string;
  attachments: StoredAttachment[];
  config: TextractFallbackConfig;
}): Promise<TextractFallbackResult> {
  if (!input.config.enabled) {
    return {
      attempted: false,
      text: null,
      attachmentsConsidered: 0,
      attachmentsProcessed: 0,
      skipped: [],
      failed: [],
    };
  }

  const considered = input.attachments.slice(0, input.config.maxAttachments);
  const skipped: Array<{ attachmentId: string; reason: string }> = [];
  const failed: Array<{ attachmentId: string; reason: string }> = [];
  const collectedLines: string[] = [];
  let attachmentsProcessed = 0;

  for (const attachment of considered) {
    if (!isTextractSupportedFile(attachment)) {
      skipped.push({
        attachmentId: attachment.id,
        reason: "unsupported_file_type",
      });
      continue;
    }

    try {
      const response = await getTextractClient(input.region).send(
        new DetectDocumentTextCommand({
          Document: {
            S3Object: {
              Bucket: attachment.s3Bucket,
              Name: attachment.s3Key,
            },
          },
        }),
      );

      attachmentsProcessed += 1;
      const lines = (response.Blocks ?? [])
        .filter((block) => block.BlockType === "LINE" && Boolean(block.Text?.trim()))
        .map((block) => block.Text!.trim());

      if (lines.length > 0) {
        collectedLines.push(lines.join("\n"));
      }
    } catch (error: unknown) {
      failed.push({
        attachmentId: attachment.id,
        reason: extractErrorMessage(error, "Unknown Textract error."),
      });
    }
  }

  const text = truncateString(collectedLines.join("\n\n"), input.config.maxTextChars);

  return {
    attempted: considered.length > 0,
    text: text && text.trim() ? text : null,
    attachmentsConsidered: considered.length,
    attachmentsProcessed,
    skipped,
    failed,
  };
}

function isTextractSupportedFile(attachment: StoredAttachment): boolean {
  const contentType = attachment.contentType?.toLowerCase() ?? "";
  if (
    contentType.includes("pdf") ||
    contentType.includes("png") ||
    contentType.includes("jpeg") ||
    contentType.includes("jpg") ||
    contentType.includes("tiff")
  ) {
    return true;
  }

  const filename = attachment.originalFilename.toLowerCase();
  return (
    filename.endsWith(".pdf") ||
    filename.endsWith(".png") ||
    filename.endsWith(".jpg") ||
    filename.endsWith(".jpeg") ||
    filename.endsWith(".tiff") ||
    filename.endsWith(".tif")
  );
}

function getTextractClient(region: string): TextractClient {
  if (textractClientSingleton) {
    return textractClientSingleton;
  }

  textractClientSingleton = new TextractClient({ region });
  return textractClientSingleton;
}
