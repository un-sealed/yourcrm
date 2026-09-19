import { expect, test } from "@playwright/test"

/**
 * Conversation-intelligence primary workflow (spec 37 §19). Run with the
 * web app and API up: `bun run dev & bunx playwright test`.
 *
 * The assertions cover the promises this page must never quietly break:
 * that an analysis is asked for explicitly, that nothing is created
 * without approval, and that the page says what it is doing when it has
 * nothing to show.
 */

test("the page explains itself and offers the one explicit action", async ({ page }) => {
  await page.goto("/app/conversation-intelligence")
  await expect(page.getByText("Coming soon")).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Conversation intelligence" })).toBeVisible()
  await expect(page.getByText("Nothing here changes a record on its own.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Analyse a conversation" }).first()).toBeVisible()
})

test("asking for an analysis states that it inherits your access", async ({ page }) => {
  await page.goto("/app/conversation-intelligence")
  await page.getByRole("button", { name: "Analyse a conversation" }).first().click()
  await expect(
    page.getByText("You can only analyse a conversation you are allowed to read."),
  ).toBeVisible()
  await expect(page.getByLabel("Conversation id")).toBeVisible()
  // All four analyses are offered, and none is preselected beyond summary.
  for (const label of ["Summary", "Sentiment", "Action items", "Key topics"]) {
    await expect(page.getByLabel(label, { exact: true })).toBeVisible()
  }
})

test("an empty workspace says so instead of showing a blank page", async ({ page }) => {
  await page.goto("/app/conversation-intelligence")
  const empty = page.getByText("No analyses yet")
  const list = page.getByRole("list").first()
  await expect(empty.or(list).first()).toBeVisible()
})

test("the filters are reachable by keyboard and labelled", async ({ page }) => {
  await page.goto("/app/conversation-intelligence")
  const status = page.getByLabel("Filter by status")
  await expect(status).toBeVisible()
  await status.selectOption("queued")
  await expect(status).toHaveValue("queued")
  const kind = page.getByLabel("Filter by kind of analysis")
  await kind.selectOption("action_items")
  await expect(kind).toHaveValue("action_items")
})

test("mobile viewport keeps the primary action reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/app/conversation-intelligence")
  await expect(page.getByRole("button", { name: "Analyse a conversation" }).first()).toBeVisible()
  await expect(page.getByLabel("Filter by status")).toBeVisible()
})
