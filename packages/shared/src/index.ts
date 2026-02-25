export const APP_NAME = "ClaimFlow";

export const CLAIM_STATUS = {
  NEW: "NEW",
  PROCESSING: "PROCESSING",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  READY: "READY",
  ERROR: "ERROR",
} as const;

export type ClaimStatus = (typeof CLAIM_STATUS)[keyof typeof CLAIM_STATUS];
