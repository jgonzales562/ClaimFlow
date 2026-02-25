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
