import { formatTokenLabel, type PillTone } from "@/lib/ui";

export type ReviewSignal = {
  badge: string;
  title: string;
  copy: string;
  tone: PillTone;
};

export function getClaimEventTone(eventType: string): "neutral" | "info" {
  return eventType === "STATUS_TRANSITION" ? "info" : "neutral";
}

export function getClaimReviewSignal(
  status: string,
  missingInfoCount: number,
  isProcessingStale = false,
): ReviewSignal {
  if (status === "ERROR") {
    return {
      badge: "Blocked",
      title: "Resolve exception",
      copy: "The claim is in an error state and should be investigated before normal processing can continue.",
      tone: "danger",
    };
  }

  if (status === "PROCESSING" && isProcessingStale) {
    return {
      badge: "Stalled",
      title: "Recover stalled intake",
      copy: "This claim has stayed in processing longer than expected and may need a manual recovery attempt.",
      tone: "warning",
    };
  }

  if (status === "READY" && missingInfoCount === 0) {
    return {
      badge: "Ready",
      title: "Advance the claim",
      copy: "The claim looks prepared to move forward without more customer follow-up.",
      tone: "success",
    };
  }

  if (status === "REVIEW_REQUIRED" || missingInfoCount > 0) {
    return {
      badge: "Attention needed",
      title: "Complete manual review",
      copy: "Analyst review or additional information is still needed before this claim is considered ready.",
      tone: "warning",
    };
  }

  if (status === "NEW" || status === "PROCESSING") {
    return {
      badge: "In intake",
      title: "Await system progress",
      copy: "The claim is still moving through intake or extraction before it reaches a review-ready state.",
      tone: "info",
    };
  }

  return {
    badge: "Open",
    title: "Monitor status",
    copy: "The claim is active, but it does not currently fit a stronger operational signal.",
    tone: "neutral",
  };
}

export function mapClaimDetailNotice(value: string | null): string | null {
  switch (value) {
    case "claim_updated":
      return "Claim updates saved.";
    case "claim_processing_recovery_started":
      return "Processing recovery queued. The worker will retry this claim.";
    case "claim_retry_started":
      return "Claim retry queued. Processing has resumed.";
    case "status_updated":
      return "Claim status updated.";
    case "status_unchanged":
      return "Status was already set to that value.";
    case "no_changes":
      return "No claim field changes were detected.";
    default:
      return null;
  }
}

export function mapClaimDetailError(value: string | null): string | null {
  switch (value) {
    case "claim_processing_recovery_failed":
      return "Unable to enqueue processing recovery for this claim.";
    case "claim_processing_recovery_not_allowed":
      return "This claim is not eligible for processing recovery.";
    case "claim_processing_recovery_not_configured":
      return "Claim processing recovery queue is not configured for this environment.";
    case "claim_processing_recovery_unavailable":
      return "This claim does not have enough inbound message context to recover processing.";
    case "claim_retry_failed":
      return "Unable to enqueue the claim retry.";
    case "claim_retry_not_allowed":
      return "This claim cannot be retried from the dashboard.";
    case "claim_retry_not_configured":
      return "Claim retry queue is not configured for this environment.";
    case "claim_retry_unavailable":
      return "This claim does not have enough inbound message context to retry.";
    case "forbidden":
      return "You do not have permission to perform that action.";
    case "invalid_warranty_status":
      return "Warranty status selection is invalid.";
    case "invalid_purchase_date":
      return "Purchase date must be in YYYY-MM-DD format.";
    case "invalid_status_target":
      return "Selected status transition target is invalid.";
    case "invalid_status_transition":
      return "This status transition is not allowed.";
    case "claim_not_found":
      return "Claim not found.";
    default:
      return null;
  }
}

export function readClaimExtractionReasoning(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  return typeof record.reasoning === "string" ? record.reasoning : null;
}

export function describeClaimEvent(eventType: string, payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return eventType === "MANUAL_EDIT" ? "Manual claim edits were saved." : "Status updated.";
  }

  const record = payload as Record<string, unknown>;

  if (eventType === "STATUS_TRANSITION") {
    const fromStatus = typeof record.fromStatus === "string" ? record.fromStatus : "unknown";
    const toStatus = typeof record.toStatus === "string" ? record.toStatus : "unknown";
    const source = typeof record.source === "string" ? record.source : null;
    if (source === "manual_processing_recovery") {
      return "Processing recovery queued";
    }
    if (source === "watchdog_processing_recovery") {
      return "Automatic processing recovery queued";
    }
    return source
      ? `${formatTokenLabel(fromStatus)} to ${formatTokenLabel(toStatus)} (${source})`
      : `${formatTokenLabel(fromStatus)} to ${formatTokenLabel(toStatus)}`;
  }

  if (eventType === "MANUAL_EDIT") {
    const changedFields = record.changedFields;
    if (Array.isArray(changedFields)) {
      const names = changedFields
        .map((entry) => {
          if (typeof entry !== "object" || entry === null) {
            return null;
          }

          const field = (entry as Record<string, unknown>).field;
          return typeof field === "string" ? field : null;
        })
        .filter((value): value is string => Boolean(value));

      if (names.length > 0) {
        return `Updated fields: ${names.join(", ")}`;
      }
    }

    return "Manual claim edits were saved.";
  }

  return formatTokenLabel(eventType);
}

export function formatClaimAttachmentBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
