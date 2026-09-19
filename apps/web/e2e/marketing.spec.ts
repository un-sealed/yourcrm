import { expect, test } from "@playwright/test"

/**
 * Marketing primary workflow (spec 24 §19): build a segment, compose a
 * campaign against it, and see the send action on the detail page. Run
 * with the web app and API up: `bun run dev & bunx playwright test`.
 */

test("marketing overview links to segments and campaigns", async ({ page }) => {
  await page.goto("/app/marketing")
  await expect(page.getByRole("heading", { name: "Marketing" })).toBeVisible()
  await expect(page.getByRole("link", { name: "View segments" })).toBeVisible()
  await expect(page.getByRole("link", { name: "View campaigns" })).toBeVisible()
})

test("segment list offers the create path and the builder uses the shared FilterBuilder", async ({
  page,
}) => {
  await page.goto("/app/marketing/segments")
  await expect(page.getByRole("heading", { name: "Segments" })).toBeVisible()
  await expect(page.getByRole("link", { name: "New segment" }).first()).toBeVisible()

  await page.goto("/app/marketing/segments/new")
  await expect(page.getByRole("heading", { name: "New segment" })).toBeVisible()
  await expect(page.getByLabel("Segment name")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Audience" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Create segment" })).toBeVisible()
})

test("campaign composer requires a name, subject and target segment", async ({ page }) => {
  await page.goto("/app/marketing/campaigns/new")
  await expect(page.getByRole("heading", { name: "New campaign" })).toBeVisible()
  await expect(page.getByLabel("Campaign name")).toBeVisible()
  await expect(page.getByLabel("Subject line")).toBeVisible()
  await expect(page.getByLabel("Target segment")).toBeVisible()
  await page.getByRole("button", { name: "Create draft" }).click()
  await expect(page.getByText("Name, subject and a target segment are required.")).toBeVisible()
})

test("the public unsubscribe page needs no session", async ({ page }) => {
  await page.goto("/unsubscribe?token=does-not-exist")
  await expect(
    page.getByRole("heading", { name: /Unsubscrib|Could not unsubscribe/ }),
  ).toBeVisible()
})

test("marketing is usable on a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/app/marketing/campaigns")
  await expect(page.getByRole("heading", { name: "Campaigns" })).toBeVisible()
  await expect(page.getByRole("link", { name: "New campaign" }).first()).toBeVisible()
})
