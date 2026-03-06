import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildClaimCursorHref,
  buildClaimListHref,
  buildClaimsExportHref,
} from "../apps/web/lib/claims/query-links.ts";

test("claim list href builder omits empty filters and appends extra params", () => {
  assert.equal(
    buildClaimListHref(
      "/dashboard/errors",
      {
        status: null,
        search: "blender",
        createdFrom: new Date("2026-03-01T00:00:00.000Z"),
        createdTo: null,
      },
      { limit: 50 },
    ),
    "/dashboard/errors?search=blender&created_from=2026-03-01&limit=50",
  );

  assert.equal(
    buildClaimListHref("/dashboard", {
      status: null,
      search: null,
      createdFrom: null,
      createdTo: null,
    }),
    "/dashboard",
  );
});

test("claim cursor href builder appends cursor and direction", () => {
  assert.equal(
    buildClaimCursorHref(
      "/dashboard",
      {
        status: "READY",
        search: "serial",
        createdFrom: null,
        createdTo: new Date("2026-03-31T00:00:00.000Z"),
      },
      "cursor-token",
      "prev",
    ),
    "/dashboard?search=serial&status=READY&created_to=2026-03-31&cursor=cursor-token&direction=prev",
  );
});

test("claim export href builder preserves filters and export settings", () => {
  assert.equal(
    buildClaimsExportHref(
      {
        status: "ERROR",
        search: "overheat",
        createdFrom: new Date("2026-02-01T00:00:00.000Z"),
        createdTo: new Date("2026-02-28T00:00:00.000Z"),
      },
      "json",
      1000,
    ),
    "/api/claims/export?search=overheat&status=ERROR&created_from=2026-02-01&created_to=2026-02-28&format=json&limit=1000",
  );
});
