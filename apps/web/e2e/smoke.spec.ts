import { expect, test } from "@playwright/test"

/** Foundation smoke: shell renders and web<->API link is live. */
test("homepage shows live API status", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "YourCRM" })).toBeVisible()
  await expect(page.getByTestId("api-status")).toContainText("Status:", { timeout: 15_000 })
})

test("dashboard renders via app shell", async ({ page }) => {
  await page.goto("/app/dashboard")
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible()
  await expect(page.getByText("API status")).toBeVisible()
})

test("implemented module routes render their own page", async ({ page }) => {
  // People is implemented, so it must NOT show the placeholder any more.
  await page.goto("/app/people")
  await expect(page.getByText("Coming soon")).toHaveCount(0)

  // WhatsApp (spec 16-whatsapp) is implemented too — same assertion.
  await page.goto("/app/whatsapp")
  await expect(page.getByText("Coming soon")).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "WhatsApp" })).toBeVisible()
})

test("unimplemented module routes still render the placeholder", async ({ page }) => {
  // Tickets (spec 21-support) has no module yet and still falls through to
  // app/[section] — unlike a made-up segment, it stays in the shell's
  // TITLES map, so this exercises the real "not built yet" placeholder
  // rather than Next's notFound().
  await page.goto("/app/tickets")
  await expect(page.getByText("Coming soon")).toBeVisible()
})
