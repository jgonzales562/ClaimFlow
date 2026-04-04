import assert from "node:assert/strict";
import { test } from "node:test";
import { buildClaimWhereInput } from "../apps/web/lib/claims/filters.ts";

test("claim filters use exact sourceEmail matching for full email searches", () => {
  const where = buildClaimWhereInput("org-1", {
    status: null,
    search: "Customer@Example.com",
    createdFrom: null,
    createdTo: null,
  });

  assert.deepEqual(where, {
    organizationId: "org-1",
    OR: [
      {
        sourceEmail: {
          equals: "customer@example.com",
          mode: "insensitive",
        },
      },
      {
        externalClaimId: {
          contains: "Customer@Example.com",
          mode: "insensitive",
        },
      },
      {
        customerName: {
          contains: "Customer@Example.com",
          mode: "insensitive",
        },
      },
      {
        productName: {
          contains: "Customer@Example.com",
          mode: "insensitive",
        },
      },
      {
        issueSummary: {
          contains: "Customer@Example.com",
          mode: "insensitive",
        },
      },
    ],
  });
});

test("claim filters keep broad sourceEmail substring matching for non-email searches", () => {
  const where = buildClaimWhereInput("org-1", {
    status: null,
    search: "example.com",
    createdFrom: null,
    createdTo: null,
  });

  assert.deepEqual(where, {
    organizationId: "org-1",
    OR: [
      {
        externalClaimId: {
          contains: "example.com",
          mode: "insensitive",
        },
      },
      {
        customerName: {
          contains: "example.com",
          mode: "insensitive",
        },
      },
      {
        productName: {
          contains: "example.com",
          mode: "insensitive",
        },
      },
      {
        issueSummary: {
          contains: "example.com",
          mode: "insensitive",
        },
      },
      {
        sourceEmail: {
          contains: "example.com",
          mode: "insensitive",
        },
      },
    ],
  });
});
