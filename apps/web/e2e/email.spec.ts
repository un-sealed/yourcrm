import { expect, test } from "@playwright/test"

/**
 * Email primary workflow (spec 14 §19). Run with the web app and API up:
 * `bun run dev & bunx playwright test`.
 */

test("email replaces the placeholder and offers the compose path", async ({ page }) => {
  await page.goto("/app/email")
  await expect(page.getByText("Coming soon")).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Email" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Compose" }).first()).toBeVisible()
})

test("the list exposes search and a status filter", async ({ page }) => {
  await page.goto("/app/email")
  await expect(page.getByLabel("Search email threads")).toBeVisible()
  await expect(page.getByLabel("Filter by thread status")).toBeVisible()
})

test("the composer validates recipients before sending", async ({ page }) => {
  await page.goto("/app/email/new")
  await expect(page.getByRole("heading", { name: "New email" })).toBeVisible()

  await page.getByLabel("To", { exact: false }).fill("not-an-address")
  await page.getByLabel("Message", { exact: false }).fill("Hello there")
  await page.getByRole("button", { name: "Send" }).click()

  // Client-side guard: the bad address is named, nothing is sent.
  await expect(page.getByText(/Not a valid email address/)).toBeVisible()
})

test("cc, bcc and record links are collapsed until asked for", async ({ page }) => {
  await page.goto("/app/email/new")
  await expect(page.getByLabel("Cc")).toBeHidden()
  await page.getByText("Cc, Bcc and record links").click()
  await expect(page.getByLabel("Cc")).toBeVisible()
  await expect(page.getByLabel("Link to person")).toBeVisible()
})

test("email is usable on a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/app/email")
  await expect(page.getByRole("heading", { name: "Email" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Compose" }).first()).toBeVisible()
})
