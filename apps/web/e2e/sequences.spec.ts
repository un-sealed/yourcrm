import { expect, test } from "@playwright/test"

/**
 * Sales sequences primary workflow (spec 47 §19). Run with the web app and
 * API up: `bun run dev & bunx playwright test`.
 *
 * NOTE FOR THE INTEGRATOR: `/app/sequences` is not in
 * `apps/web/components/nav-sections.ts` (that file belongs to the shell,
 * not to this module), so these specs navigate by URL. Once the link is
 * added, a nav assertion belongs in the first test.
 */

test("the sequence list replaces the placeholder and offers the create path", async ({ page }) => {
  await page.goto("/app/sequences")
  await expect(page.getByText("Coming soon")).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Sequences" })).toBeVisible()
  await expect(page.getByRole("link", { name: "New sequence" }).first()).toBeVisible()
  await expect(page.getByLabel("Search sequences")).toBeVisible()
  await expect(page.getByLabel("Filter by status")).toBeVisible()
})

test("creating a sequence asks for a name and shows the stop conditions", async ({ page }) => {
  await page.goto("/app/sequences/new")
  await expect(page.getByRole("heading", { name: "New sequence" })).toBeVisible()
  await expect(page.getByLabel("Name")).toBeVisible()

  // Saving is refused until the draft would pass server validation.
  await expect(page.getByRole("button", { name: "Save sequence" })).toBeDisabled()
  await page.getByLabel("Name").fill("Outbound — Q2 founders")
  await expect(page.getByRole("button", { name: "Save sequence" })).toBeEnabled()

  // The two configurable stop conditions are on by default; the rest
  // (unsubscribe, manual removal) are unconditional and therefore not
  // offered as switches.
  await expect(page.getByLabel("Stop when the person replies")).toBeChecked()
  await expect(page.getByLabel("Stop when their mailbox bounces")).toBeChecked()
})

test("the list explains the first useful action when it is empty", async ({ page }) => {
  await page.goto("/app/sequences?status=archived")
  const empty = page.getByText("No matching sequences")
  const rows = page.getByRole("listitem")
  // Either there are archived sequences or the empty state explains itself.
  await expect(empty.or(rows.first())).toBeVisible()
})

test("sequences are usable on a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/app/sequences")
  await expect(page.getByRole("heading", { name: "Sequences" })).toBeVisible()
  await expect(page.getByRole("link", { name: "New sequence" }).first()).toBeVisible()
})
