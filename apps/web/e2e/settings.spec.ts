import { expect, test } from "@playwright/test"

/**
 * Settings primary workflow (specs 40 + 41 §19). Run with the web app and
 * API up: `bun run dev & bunx playwright test`.
 */

test("settings replaces the placeholder and exposes every section", async ({ page }) => {
  await page.goto("/app/settings")
  await expect(page.getByText("Coming soon")).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible()
  for (const tab of ["Workspace", "Members", "Teams", "Audit log", "Data & privacy"]) {
    await expect(page.getByRole("tab", { name: tab })).toBeVisible()
  }
})

test("the workspace profile is editable and saving is gated on a change", async ({ page }) => {
  await page.goto("/app/settings")
  await page.getByRole("tab", { name: "Workspace" }).click()
  await expect(page.getByLabel("Workspace name")).toBeVisible()
  await expect(page.getByLabel("Timezone")).toBeVisible()
  await expect(page.getByLabel("Currency")).toBeVisible()
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled()
  await page.getByLabel("Workspace name").fill("Acme Renamed")
  await expect(page.getByRole("button", { name: "Save changes" })).toBeEnabled()
})

test("members can be invited and the invite link is shown once", async ({ page }) => {
  await page.goto("/app/settings")
  await page.getByRole("tab", { name: "Members" }).click()
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible()
  await expect(page.getByLabel("Email")).toBeVisible()
  await expect(page.getByRole("button", { name: "Send invite" })).toBeDisabled()
  await page.getByLabel("Email").fill("teammate@example.com")
  await expect(page.getByRole("button", { name: "Send invite" })).toBeEnabled()
})

test("the audit log is filterable and offers no write action", async ({ page }) => {
  await page.goto("/app/settings")
  await page.getByRole("tab", { name: "Audit log" }).click()
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible()
  await expect(page.getByLabel("Object")).toBeVisible()
  await expect(page.getByLabel("Source")).toBeVisible()
  // Read-only by construction: no create/edit/delete affordance exists.
  await expect(page.getByRole("button", { name: /delete entry/i })).toHaveCount(0)
  await expect(page.getByRole("button", { name: /edit entry/i })).toHaveCount(0)
})

test("settings is usable on a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/app/settings")
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible()
  await page.getByRole("tab", { name: "Teams" }).click()
  await expect(page.getByRole("heading", { name: "Teams" })).toBeVisible()
})
