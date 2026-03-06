export function isInlinePreviewableAttachment(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }

  const normalized = contentType.trim().toLowerCase();
  return normalized === "application/pdf" || normalized.startsWith("image/");
}
