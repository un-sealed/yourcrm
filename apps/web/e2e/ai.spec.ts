import { expect, test } from "@playwright/test"

/**
 * Ask-Your-CRM primary workflow (spec 34 §19). Run with the web app and
 * API up: `bun run dev & bunx playwright test`.
 *
 * These assertions deliberately cover the three things the page must never
 * lose: the composer, the read-only promise, and model attribution.
 */

test("the assistant replaces the placeholder and offers a composer", async ({ page }) => {
  await page.goto("/app/ai")
  await expect(page.getByText("Coming soon")).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "AI Assistant" })).toBeVisible()
  await expect(page.getByLabel("Your question")).toBeVisible()
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible()
})

test("the empty state suggests a first question and the send button starts disabled", async ({
  page,
}) => {
  await page.goto("/app/ai")
  await expect(page.getByText("Ask your first question")).toBeVisible()
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled()
})

test("the page states that the assistant is read-only", async ({ page }) => {
  await page.goto("/app/ai")
  await expect(page.getByText(/Read-only in this release/)).toBeVisible()
})

test("asking a question shows a pending turn and then an attributed answer", async ({ page }) => {
  await page.goto("/app/ai")
  await page.getByLabel("Your question").fill("How many deals are in each stage?")
  await page.getByRole("button", { name: "Send" }).click()

  // Honest pending state: no fake streaming, but never a frozen button.
  await expect(page.getByRole("status")).toBeVisible()

  // The answer carries the model that produced it (spec 34 §14).
  const answer = page.locator("li p.text-xs").last()
  await expect(answer).toBeVisible({ timeout: 60_000 })
  await expect(answer).toContainText("tokens")
})

test("the assistant is usable on a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/app/ai")
  await expect(page.getByRole("heading", { name: "AI Assistant" })).toBeVisible()
  await expect(page.getByLabel("Your question")).toBeVisible()
  await expect(page.getByRole("button", { name: "History" })).toBeVisible()
})
