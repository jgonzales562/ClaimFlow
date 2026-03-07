import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeClaimEvent,
  formatClaimAttachmentBytes,
  getClaimEventTone,
  getClaimReviewSignal,
  mapClaimDetailError,
  mapClaimDetailNotice,
  readClaimExtractionReasoning,
} from "../apps/web/lib/claims/claim-detail-ui.ts";

test("claim detail notice and error mappings return expected user-facing messages", () => {
  assert.equal(mapClaimDetailNotice("claim_updated"), "Claim updates saved.");
  assert.equal(mapClaimDetailNotice("claim_retry_started"), "Claim retry queued. Processing has resumed.");
  assert.equal(mapClaimDetailNotice("status_unchanged"), "Status was already set to that value.");
  assert.equal(mapClaimDetailNotice("unknown"), null);

  assert.equal(
    mapClaimDetailError("claim_retry_not_allowed"),
    "This claim cannot be retried from the dashboard.",
  );
  assert.equal(
    mapClaimDetailError("claim_retry_not_configured"),
    "Claim retry queue is not configured for this environment.",
  );
  assert.equal(
    mapClaimDetailError("invalid_status_transition"),
    "This status transition is not allowed.",
  );
  assert.equal(mapClaimDetailError("claim_not_found"), "Claim not found.");
  assert.equal(mapClaimDetailError("unknown"), null);
});

test("claim detail review signal picks the expected operational posture", () => {
  assert.deepEqual(getClaimReviewSignal("ERROR", 0), {
    badge: "Blocked",
    title: "Resolve exception",
    copy: "The claim is in an error state and should be investigated before normal processing can continue.",
    tone: "danger",
  });

  assert.deepEqual(getClaimReviewSignal("READY", 0), {
    badge: "Ready",
    title: "Advance the claim",
    copy: "The claim looks prepared to move forward without more customer follow-up.",
    tone: "success",
  });

  assert.equal(getClaimReviewSignal("PROCESSING", 1).tone, "warning");
  assert.equal(getClaimReviewSignal("NEW", 0).tone, "info");
});

test("claim detail event helpers format extraction and audit payloads safely", () => {
  assert.equal(readClaimExtractionReasoning({ reasoning: "Detailed reasoning" }), "Detailed reasoning");
  assert.equal(readClaimExtractionReasoning({ reasoning: 42 }), null);
  assert.equal(readClaimExtractionReasoning(null), null);

  assert.equal(getClaimEventTone("STATUS_TRANSITION"), "info");
  assert.equal(getClaimEventTone("MANUAL_EDIT"), "neutral");

  assert.equal(
    describeClaimEvent("STATUS_TRANSITION", {
      fromStatus: "REVIEW_REQUIRED",
      toStatus: "READY",
      source: "manual_review",
    }),
    "Review Required to Ready (manual_review)",
  );
  assert.equal(
    describeClaimEvent("MANUAL_EDIT", {
      changedFields: [{ field: "customerName" }, { field: "purchaseDate" }],
    }),
    "Updated fields: customerName, purchaseDate",
  );
  assert.equal(describeClaimEvent("MANUAL_EDIT", null), "Manual claim edits were saved.");
  assert.equal(describeClaimEvent("CUSTOM_EVENT", {}), "Custom Event");
});

test("claim detail byte formatting uses the expected units", () => {
  assert.equal(formatClaimAttachmentBytes(512), "512 B");
  assert.equal(formatClaimAttachmentBytes(1536), "1.5 KB");
  assert.equal(formatClaimAttachmentBytes(2 * 1024 * 1024), "2.0 MB");
});
