import { expect, test } from "@playwright/test"

/**
 * AI approval queue, primary workflow (spec 38 §19). Run with the web app
 * and API up: `bun run dev & bunx playwright test`.
 */

test("the approval queue replaces the placeholder and explains itself", async ({ page }) => {
  await page.goto("/app/ai/governance")
  await expect(page.getByText("Coming soon")).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "AI approvals" })).toBeVisible()
  await expect(
    page.getByText("Nothing an AI proposes touches a record until a person approves it here."),
  ).toBeVisible()
})

test("the reviewer can filter the queue by status", async ({ page }) => {
  await page.goto("/app/ai/governance")
  const filter = page.getByLabel("Filter by status")
  await expect(filter).toBeVisible()
  await filter.selectOption("applied")
  await expect(filter).toHaveValue("applied")
})

test("an empty queue says so instead of showing a blank page", async ({ page }) => {
  await page.goto("/app/ai/governance")
  // Either there is something waiting, or the empty state explains why not.
  const empty = page.getByText("Nothing is waiting for you")
  const list = page.getByRole("list", { name: "Proposed AI actions" })
  await expect(empty.or(list).first()).toBeVisible()
})

test("the queue is usable on a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/app/ai/governance")
  await expect(page.getByRole("heading", { name: "AI approvals" })).toBeVisible()
  await expect(page.getByLabel("Filter by status")).toBeVisible()
})
