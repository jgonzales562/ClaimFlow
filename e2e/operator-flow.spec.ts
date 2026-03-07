import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

test.describe("admin claim operator flows", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
  });

  test("admin can filter claims and open the seeded review claim", async ({ page }) => {
    test.setTimeout(90_000);

    await openSeededClaim(page, "seed-claim-001");

    await expect(page.getByLabel("Product Name")).toHaveValue("Acme ProCool X1200");
    await expect(page.getByLabel("Customer Name")).toHaveValue("Jordan Miles");
    await expect(page.getByText("Review Required").first()).toBeVisible();
  });

  test("admin can update a seeded claim from the review form", async ({ page }) => {
    test.setTimeout(90_000);

    await openSeededClaim(page, "seed-claim-002");

    await page.getByLabel("Product Name").fill("Acme HeatCore Z500 Mk II");
    await page
      .getByLabel("Issue Summary")
      .fill("Unit stops heating after the first five minutes of runtime.");
    await page
      .getByLabel("Missing Info (one per line)")
      .fill("proof_of_purchase\ninstallation_photo");

    await Promise.all([
      page.waitForURL((url) => url.searchParams.get("notice") === "claim_updated"),
      page.getByRole("button", { name: "Save claim updates" }).click(),
    ]);

    await expect(page.getByText("Claim updates saved.")).toBeVisible();
    await expect(page.getByLabel("Product Name")).toHaveValue("Acme HeatCore Z500 Mk II");
    await expect(page.getByLabel("Issue Summary")).toHaveValue(
      "Unit stops heating after the first five minutes of runtime.",
    );
    await expect(page.getByLabel("Missing Info (one per line)")).toHaveValue(
      "proof_of_purchase\ninstallation_photo",
    );
    await expect(
      page.getByRole("cell", {
        name: "Updated fields: productName, issueSummary, missingInfo",
      }).first(),
    ).toBeVisible();
  });

  test("admin can transition a review-required claim to ready", async ({ page }) => {
    test.setTimeout(90_000);

    await openSeededClaim(page, "seed-claim-003");

    await Promise.all([
      page.waitForURL((url) => url.searchParams.get("notice") === "status_updated"),
      page.getByRole("button", { name: "Mark as READY" }).click(),
    ]);

    await expect(page.getByText("Claim status updated.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Return to REVIEW_REQUIRED" })).toBeVisible();
    await expect(
      page.getByRole("cell", { name: "Review Required to Ready" }).first(),
    ).toBeVisible();
  });

  test("admin can export filtered claims from the dashboard", async ({ page }, testInfo) => {
    test.setTimeout(90_000);

    await page.getByLabel("Search").fill("seed-claim-001");
    await page.getByLabel("Status").selectOption("REVIEW_REQUIRED");
    await Promise.all([
      page.waitForURL(
        (url) =>
          url.pathname === "/dashboard" &&
          url.searchParams.get("search") === "seed-claim-001" &&
          url.searchParams.get("status") === "REVIEW_REQUIRED",
      ),
      page.getByRole("button", { name: "Apply filters" }).click(),
    ]);

    const [csvDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Export CSV" }).click(),
    ]);
    expect(csvDownload.suggestedFilename()).toMatch(/^claims-export-.*\.csv$/);
    const csvPath = testInfo.outputPath("claims-export.csv");
    await csvDownload.saveAs(csvPath);
    const csvContents = await readFile(csvPath, "utf8");
    expect(csvContents).toContain("claim_id,external_claim_id,source_email");
    expect(csvContents).toContain("seed-claim-001");
    expect(csvContents).not.toContain("seed-claim-002");

    const [jsonDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Export JSON" }).click(),
    ]);
    expect(jsonDownload.suggestedFilename()).toMatch(/^claims-export-.*\.json$/);
    const jsonPath = testInfo.outputPath("claims-export.json");
    await jsonDownload.saveAs(jsonPath);
    const jsonContents = JSON.parse(await readFile(jsonPath, "utf8")) as {
      count: number;
      filters: {
        status: string | null;
        search: string | null;
      };
      claims: Array<{
        externalClaimId: string | null;
        status: string;
      }>;
    };

    expect(jsonContents.count).toBe(1);
    expect(jsonContents.filters).toMatchObject({
      status: "REVIEW_REQUIRED",
      search: "seed-claim-001",
    });
    expect(jsonContents.claims).toHaveLength(1);
    expect(jsonContents.claims[0]).toMatchObject({
      externalClaimId: "seed-claim-001",
      status: "REVIEW_REQUIRED",
    });
  });

  test("admin can inspect seeded attachment actions on a claim", async ({ page }) => {
    test.setTimeout(90_000);

    await openSeededClaim(page, "seed-claim-005");

    const attachmentRow = page.getByRole("row", { name: /installer-report\.pdf/i });
    await expect(attachmentRow.getByText("installer-report.pdf")).toBeVisible();
    await expect(attachmentRow.getByText("Stored")).toBeVisible();
    await expect(attachmentRow.getByText("application/pdf")).toBeVisible();
    await expect(attachmentRow.getByText("256.0 KB")).toBeVisible();

    const viewLink = attachmentRow.getByRole("link", { name: "View" });
    const downloadLink = attachmentRow.getByRole("link", { name: "Download" });
    const viewHref = await viewLink.getAttribute("href");
    const downloadHref = await downloadLink.getAttribute("href");

    expect(viewHref).toMatch(
      /^\/api\/claims\/[^/]+\/attachments\/[^/]+\/download\?disposition=inline$/,
    );
    expect(downloadHref).toMatch(/^\/api\/claims\/[^/]+\/attachments\/[^/]+\/download$/);
  });

  test("admin can triage a seeded error claim from the exception queue", async ({ page }) => {
    test.setTimeout(90_000);

    await Promise.all([
      page.waitForURL(/\/dashboard\/errors(?:\?|$)/),
      page.getByRole("link", { name: "Error Triage" }).click(),
    ]);

    await expect(page.getByRole("heading", { name: "Error Claim Triage" })).toBeVisible();

    await page.getByLabel("Search").fill("seed-claim-004");
    await Promise.all([
      page.waitForURL(
        (url) =>
          url.pathname === "/dashboard/errors" && url.searchParams.get("search") === "seed-claim-004",
      ),
      page.getByRole("button", { name: "Refresh" }).click(),
    ]);

    const row = page.getByRole("row", { name: /seed-claim-004/i });
    await expect(row.getByText("Document classification failed after OCR fallback.")).toBeVisible();
    await expect(row.getByText("No", { exact: true })).toBeVisible();
    await expect(row.getByRole("cell", { name: "4", exact: true })).toBeVisible();
    await expect(row.getByText("Moved To Dlq")).toBeVisible();

    await row.getByRole("link", { name: "Open claim" }).click();
    await expect(page).toHaveURL(/\/dashboard\/claims\/.+/, { timeout: 30_000 });
    await expect(page.getByText("Resolve exception")).toBeVisible();
    await expect(
      page.getByText("Transition actions appear once the claim reaches review-ready states."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark as READY" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Return to REVIEW_REQUIRED" })).toHaveCount(0);
    await expect(
      page.getByRole("cell", { name: "Processing to Error (worker_failure)" }).first(),
    ).toBeVisible();
  });

  test("admin can see retry controls for retryable error claims", async ({ page }) => {
    test.setTimeout(90_000);

    await Promise.all([
      page.waitForURL(/\/dashboard\/errors(?:\?|$)/),
      page.getByRole("link", { name: "Error Triage" }).click(),
    ]);

    await page.getByLabel("Search").fill("seed-claim-006");
    await Promise.all([
      page.waitForURL(
        (url) =>
          url.pathname === "/dashboard/errors" && url.searchParams.get("search") === "seed-claim-006",
      ),
      page.getByRole("button", { name: "Refresh" }).click(),
    ]);

    const row = page.getByRole("row", { name: /seed-claim-006/i });
    await expect(row.getByText("Yes", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Retry claim" })).toBeVisible();

    await row.getByRole("link", { name: "Open claim" }).click();
    await expect(page).toHaveURL(/\/dashboard\/claims\/.+/, { timeout: 30_000 });
    await expect(page.getByText("Resolve exception")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry claim" })).toBeVisible();
    await expect(
      page.getByText("The latest worker failure is marked retryable"),
    ).toBeVisible();
  });

  test("admin can see recovery controls for stale processing claims", async ({ page }) => {
    test.setTimeout(90_000);

    await page.getByLabel("Search").fill("seed-claim-007");
    await Promise.all([
      page.waitForURL(
        (url) => url.pathname === "/dashboard" && url.searchParams.get("search") === "seed-claim-007",
      ),
      page.getByRole("button", { name: "Apply filters" }).click(),
    ]);

    const claimLink = page.getByRole("link", { name: "seed-claim-007" });
    await expect(claimLink).toBeVisible();
    await expect(page.getByText("Recovery available")).toBeVisible();

    await claimLink.click();
    await expect(page).toHaveURL(/\/dashboard\/claims\/.+/, { timeout: 30_000 });
    await expect(page.getByText("Recover stalled intake")).toBeVisible();
    await expect(page.getByRole("button", { name: "Recover processing" })).toBeVisible();
    await expect(
      page.getByText("This claim has been processing longer than expected."),
    ).toBeVisible();
  });
});

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "Sign in to ClaimFlow" })).toBeVisible();

  await page.getByLabel("Email").fill("admin@claimflow.local");
  await page.getByLabel("Password").fill("Moonbeem7!");
  await Promise.all([
    page.waitForURL(/\/dashboard(?:\?|$)/),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);

  await expect(page.getByRole("heading", { name: "ClaimFlow Dashboard" })).toBeVisible();
}

async function openSeededClaim(page: Page, claimReference: string): Promise<void> {
  await page.getByLabel("Search").fill(claimReference);
  await Promise.all([
    page.waitForURL(
      (url) => url.pathname === "/dashboard" && url.searchParams.get("search") === claimReference,
    ),
    page.getByRole("button", { name: "Apply filters" }).click(),
  ]);

  const claimLink = page.getByRole("link", { name: claimReference });
  await expect(claimLink).toBeVisible();
  await claimLink.click();
  await expect(page).toHaveURL(/\/dashboard\/claims\/.+/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Claim Review" })).toBeVisible({
    timeout: 30_000,
  });
}
