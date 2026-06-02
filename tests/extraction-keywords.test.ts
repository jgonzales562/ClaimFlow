import assert from "node:assert/strict";
import { test } from "node:test";
import { extractClaimData, scanConfiguredKeywords } from "../apps/worker/src/extraction.ts";

test("configured keyword scan matches organization terms in inbound content", () => {
  const matches = scanConfiguredKeywords({
    subject: "Warranty claim",
    strippedTextReply: "Customer included proof of purchase.",
    textBody: "The Compressor Failure started yesterday.",
    claimIssueSummary: null,
    supplementalText: null,
    organizationScanKeywords: [
      "compressor failure",
      "proof of purchase",
      "dealer code",
      "Compressor Failure",
    ],
  });

  assert.deepEqual(matches, ["compressor failure", "proof of purchase"]);
});

test("fallback extraction records deterministic keyword matches", async () => {
  const result = await extractClaimData(
    {
      providerMessageId: "keyword-provider",
      fromEmail: "customer@example.com",
      subject: "Warranty claim",
      textBody: "Receipt has the RMA code, but no dealer code is visible.",
      strippedTextReply: null,
      claimIssueSummary: null,
      supplementalText: null,
      organizationScanKeywords: ["RMA code", "dealer code", "installation invoice"],
    },
    {
      openAiApiKey: null,
      model: "test-model",
      maxInputChars: 2_000,
    },
  );

  assert.deepEqual(result.extraction.keywordMatches, ["RMA code", "dealer code"]);
  assert.deepEqual(result.rawOutput.keywordMatches, ["RMA code", "dealer code"]);
});
