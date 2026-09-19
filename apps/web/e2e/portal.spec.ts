import { expect, test } from "@playwright/test"

/**
 * Customer portal (spec 45-customer-portal, P0) — primary workflow.
 *
 * The workflow a customer actually performs is "ask for a link". Everything
 * after that needs a real mailbox, so this spec covers the half that can be
 * driven from a browser and asserts the property that matters most about it:
 * the page says the same thing whatever happened, so nobody can use it to
 * discover who has portal access.
 *
 * It also checks the negative space: the portal must not be reachable
 * through the member app shell, and a signed-out visitor must not be shown
 * customer data.
 */

const GENERIC = /If that email address has portal access/i

test("the portal sign-in page renders with no password field", async ({ page }) => {
  await page.goto("/portal/login")
  await expect(page.getByRole("heading", { name: "Sign in to your portal" })).toBeVisible()
  await expect(page.getByLabel("Email")).toBeVisible()
  await expect(page.locator('input[type="password"]')).toHaveCount(0)
})

test("requesting a link says the same thing for an unknown address", async ({ page }) => {
  await page.goto("/portal/login")
  await page.getByLabel("Email").fill("definitely-not-a-customer@example.com")
  await page.getByRole("button", { name: /Email me a sign-in link/i }).click()
  await expect(page.getByRole("status")).toContainText(GENERIC)
  // No wording anywhere that would confirm or deny the address.
  await expect(page.getByText(/no account|not found|unknown email/i)).toHaveCount(0)
})

test("a spent or invented magic link fails closed", async ({ page }) => {
  await page.goto("/portal/verify?token=not-a-real-token-0123456789")
  await expect(page.getByRole("alert")).toContainText(/no longer works/i)
  await expect(page.getByRole("link", { name: /Request a new link/i })).toBeVisible()
})

test("portal pages do not render the member app shell", async ({ page }) => {
  await page.goto("/portal/login")
  // The CRM sidebar sections must not appear on a customer-facing page.
  await expect(page.getByRole("link", { name: "Pipelines", exact: true })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0)
})

test("a signed-out visitor is bounced from portal pages, with no data on screen", async ({
  page,
}) => {
  await page.goto("/portal/invoices")
  // The API answers 401, the page redirects to sign-in. Either way: no rows.
  await page.waitForURL(/\/portal\/(login|invoices)/)
  await expect(page.getByText(/INV-/)).toHaveCount(0)
})
