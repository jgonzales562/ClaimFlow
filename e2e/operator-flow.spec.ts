import { expect, test } from "@playwright/test";

test("admin can sign in, filter claims, and open the seeded review claim", async ({ page }) => {
  test.setTimeout(90_000);

  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "Sign in to ClaimFlow" })).toBeVisible();

  await page.getByLabel("Email").fill("admin@claimflow.local");
  await page.getByLabel("Password").fill("Moonbeem7!");
  await Promise.all([
    page.waitForURL(/\/dashboard(?:\?|$)/),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  await expect(page.getByRole("heading", { name: "ClaimFlow Dashboard" })).toBeVisible();

  await page.getByLabel("Search").fill("seed-claim-001");
  await Promise.all([
    page.waitForURL(/\/dashboard\?search=seed-claim-001/),
    page.getByRole("button", { name: "Apply filters" }).click(),
  ]);

  const claimLink = page.getByRole("link", { name: "seed-claim-001" });
  await expect(claimLink).toBeVisible();
  await claimLink.click();
  await expect(page).toHaveURL(/\/dashboard\/claims\/.+/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Claim Review" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByLabel("Product Name")).toHaveValue("Acme ProCool X1200");
  await expect(page.getByLabel("Customer Name")).toHaveValue("Jordan Miles");
  await expect(page.getByText("Review Required").first()).toBeVisible();
});
