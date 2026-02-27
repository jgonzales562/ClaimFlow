export type PostmarkInboundPayload = {
  MessageID: string;
  MailboxHash?: string | null;
  Date?: string | null;
  Subject?: string | null;
  From?: string | null;
  To?: string | null;
  TextBody?: string | null;
  HtmlBody?: string | null;
  StrippedTextReply?: string | null;
  ToFull?: Array<{
    Email?: string | null;
    Name?: string | null;
    MailboxHash?: string | null;
  }> | null;
  Attachments?: PostmarkAttachment[] | null;
};

export type PostmarkAttachment = {
  Name?: string | null;
  Content?: string | null;
  ContentType?: string | null;
  ContentLength?: number | null;
  ContentID?: string | null;
};

type ParsedAddress = {
  email: string | null;
  name: string | null;
};

export function isPostmarkInboundPayload(value: unknown): value is PostmarkInboundPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const payload = value as Record<string, unknown>;
  return typeof payload.MessageID === "string" && payload.MessageID.trim().length > 0;
}

export function getMailboxHash(payload: PostmarkInboundPayload): string | null {
  if (typeof payload.MailboxHash === "string" && payload.MailboxHash.trim()) {
    return payload.MailboxHash.trim();
  }

  const candidate = payload.ToFull?.find(
    (to) => typeof to.MailboxHash === "string" && Boolean(to.MailboxHash?.trim()),
  );
  return candidate?.MailboxHash?.trim() ?? null;
}

export function parsePostmarkAddress(value: string | null | undefined): ParsedAddress {
  if (!value || !value.trim()) {
    return { email: null, name: null };
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^(.*)<([^>]+)>$/);
  if (!match) {
    return { email: trimmed.toLowerCase(), name: null };
  }

  const [, rawName, rawEmail] = match;
  const name = rawName.replace(/^"|"$/g, "").trim();
  return {
    email: rawEmail.trim().toLowerCase(),
    name: name || null,
  };
}

export function parseReceivedAt(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

export function getPostmarkAttachments(payload: PostmarkInboundPayload) {
  return (payload.Attachments ?? [])
    .map((attachment, index) => normalizeAttachment(attachment, index))
    .filter((attachment): attachment is NormalizedPostmarkAttachment => attachment !== null);
}

export type NormalizedPostmarkAttachment = {
  originalFilename: string;
  contentType: string | null;
  byteSize: number;
  base64Content: string;
  contentId: string | null;
};

function normalizeAttachment(
  value: PostmarkAttachment,
  index: number,
): NormalizedPostmarkAttachment | null {
  if (!value) {
    return null;
  }

  const base64Content = typeof value.Content === "string" ? value.Content.trim() : "";
  if (!base64Content) {
    return null;
  }

  const fallbackFilename = `attachment-${index + 1}.bin`;
  const originalFilename =
    typeof value.Name === "string" && value.Name.trim() ? value.Name.trim() : fallbackFilename;

  const contentType =
    typeof value.ContentType === "string" && value.ContentType.trim()
      ? value.ContentType.trim()
      : null;

  const parsedByteSize =
    typeof value.ContentLength === "number" && Number.isFinite(value.ContentLength)
      ? Math.max(Math.floor(value.ContentLength), 0)
      : Math.floor((base64Content.length * 3) / 4);

  const contentId =
    typeof value.ContentID === "string" && value.ContentID.trim() ? value.ContentID.trim() : null;

  return {
    originalFilename,
    contentType,
    byteSize: parsedByteSize,
    base64Content,
    contentId,
  };
}
