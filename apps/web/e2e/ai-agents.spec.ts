import { expect, test } from "@playwright/test"

/**
 * AI agents, primary workflow (spec 36 §19). Run with the web app and API
 * up: `bun run dev & bunx playwright test`.
 */

test("the agents page replaces the placeholder and states the safety rule", async ({ page }) => {
  await page.goto("/app/ai/agents")
  await expect(page.getByText("Coming soon")).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "AI agents" })).toBeVisible()
  await expect(page.getByText(/can only propose changes/)).toBeVisible()
})

test("an empty workspace says so instead of showing a blank page", async ({ page }) => {
  await page.goto("/app/ai/agents")
  const empty = page.getByText("No agents yet")
  const list = page.getByRole("list", { name: "AI agents" })
  await expect(empty.or(list).first()).toBeVisible()
})

test("the approvals queue is one click away from an agent", async ({ page }) => {
  await page.goto("/app/ai/agents")
  const link = page.getByRole("link", { name: "AI approvals" })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute("href", "/app/ai/governance")
})

test("the page is usable on a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/app/ai/agents")
  await expect(page.getByRole("heading", { name: "AI agents" })).toBeVisible()
})
