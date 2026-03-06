export type PillTone = "neutral" | "info" | "success" | "warning" | "danger";

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function formatTokenLabel(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function getClaimStatusTone(status: string): PillTone {
  switch (status) {
    case "READY":
      return "success";
    case "REVIEW_REQUIRED":
      return "warning";
    case "ERROR":
      return "danger";
    case "PROCESSING":
      return "info";
    default:
      return "neutral";
  }
}

export function getWarrantyTone(status: string): PillTone {
  switch (status) {
    case "LIKELY_IN_WARRANTY":
      return "success";
    case "LIKELY_EXPIRED":
      return "danger";
    default:
      return "warning";
  }
}

export function getBooleanTone(value: boolean | null | undefined): PillTone {
  if (value == null) {
    return "neutral";
  }

  return value ? "success" : "danger";
}

export function toPercent(count: number, total: number): number {
  if (total === 0) {
    return 0;
  }

  return Math.round((count / total) * 100);
}

export function formatPercent(value: number): string {
  return `${value}%`;
}

export function formatClaimReference(externalClaimId: string | null, claimId: string): string {
  return externalClaimId ?? claimId.slice(0, 12);
}
