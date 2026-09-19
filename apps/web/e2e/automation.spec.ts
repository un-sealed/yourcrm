import { expect, test } from "@playwright/test"

/**
 * Automation primary workflow (spec 25 §19). Run with the web app and API
 * up: `bun run dev & bunx playwright test`.
 */

test("automation replaces the placeholder and offers the create path", async ({ page }) => {
  await page.goto("/app/automation")
  await expect(page.getByText("Coming soon")).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Automation" })).toBeVisible()
  await expect(page.getByRole("link", { name: "New automation" }).first()).toBeVisible()
})

test("the builder walks trigger -> conditions -> actions", async ({ page }) => {
  await page.goto("/app/automation/new")
  await expect(page.getByRole("heading", { name: "New automation" })).toBeVisible()
  await expect(page.getByLabel("Name")).toBeVisible()
  await expect(page.getByLabel("Trigger")).toBeVisible()
  await expect(page.getByRole("button", { name: "Add conditions" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Add action" })).toBeVisible()

  // Saving is refused until the draft would pass server validation.
  await expect(page.getByRole("button", { name: "Save automation" })).toBeDisabled()
  await page.getByLabel("Name").fill("Welcome new people")
  await expect(page.getByRole("button", { name: "Save automation" })).toBeDisabled()
})

test("run history renders its own page with an explanation", async ({ page }) => {
  await page.goto("/app/automation/runs")
  await expect(page.getByRole("heading", { name: "Automation runs" })).toBeVisible()
  await expect(page.getByLabel("Filter by run status")).toBeVisible()
})

test("automation is usable on a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/app/automation")
  await expect(page.getByRole("heading", { name: "Automation" })).toBeVisible()
  await expect(page.getByRole("link", { name: "New automation" }).first()).toBeVisible()
})
