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
      page.getByRole("cell", { name: "Processing to Error (worker_failure)" }).first(),
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
