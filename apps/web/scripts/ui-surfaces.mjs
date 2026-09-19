// TEMPORARY surfaces harness — delete after the review run.
import { chromium } from "@playwright/test"

const BASE = process.env.REVIEW_BASE ?? "http://localhost:3000"
const API = process.env.REVIEW_API ?? "http://localhost:4000"

const PAGES = (
  process.env.REVIEW_PAGES ??
  [
    "/app/dashboard",
    "/app/people",
    "/app/deals",
    "/app/tasks",
    "/app/quotes",
    "/app/invoices",
    "/app/tickets",
    "/app/calling",
    "/app/automation",
    "/app/reports",
    "/app/dashboards",
    "/app/import-export",
    "/app/ai",
    "/app/ai/agents",
    "/app/ai/governance",
    "/app/settings",
    "/app/marketing",
    "/app/marketing/campaigns",
    "/app/customer-success",
    "/app/knowledge-base",
    "/app/booking-links",
    "/app/integrations",
    "/app/api-webhooks",
    "/app/notifications",
    "/app/files",
    "/app/forms",
    "/app/products",
    "/app/leads",
    "/app/activities",
    "/app/settings/notifications",
    "/app/settings/onboarding",
    "/app/pipelines",
    "/app/sequences",
    "/app/whatsapp",
    "/app/inbox",
    "/app/calendar",
    "/app/email",
    "/app/calling",
    "/app/custom-objects",
    "/app/conversation-intelligence",
    "/app/knowledge-base",
    "/app/search",
    "/app/booking-links",
    "/app/dashboards",
    "/app/marketplace",
    "/app/integrations",
    "/app/api-webhooks",
  ]
)

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.request.post(`${API}/api/v1/auth/login`, {
  data: { email: "admin@yourcrm.local", password: "Password123!" },
})

for (const path of PAGES) {
  const page = await context.newPage()
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 30_000 })
    await page.waitForTimeout(250)
    const found = await page.evaluate(() => {
      const transparent = (c) => !c || c === "transparent" || /rgba?\([^)]*,\s*0\)$/.test(c)
      // The page canvas is whatever body paints; anything bordered sitting
      // directly on it (rather than on a card) reads as an unstyled box.
      const canvas = getComputedStyle(document.body).backgroundColor
      const out = []
      for (const el of document.querySelectorAll("main *")) {
        const cs = getComputedStyle(el)
        if (cs.borderTopWidth === "0px") continue
        if (Number.parseFloat(cs.borderTopWidth) < 1) continue
        if (!transparent(cs.backgroundColor)) continue
        const r = el.getBoundingClientRect()
        if (r.width < 200 || r.height < 24) continue
        // Nearest painted ancestor background.
        let host = null
        for (let p = el.parentElement; p; p = p.parentElement) {
          const pcs = getComputedStyle(p)
          if (!transparent(pcs.backgroundColor)) {
            host = { tag: p.tagName.toLowerCase(), bg: pcs.backgroundColor }
            break
          }
        }
        if (!host) continue
        // Only care when the box sits on the page canvas, not inside a card.
        if (host.bg !== canvas) continue
        out.push({
          cls: (el.className || "").toString().slice(0, 95),
          w: Math.round(r.width),
          text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 45),
          hostTag: host.tag,
        })
        if (out.length >= 12) break
      }
      return out
    })
    if (found.length) {
      console.log(`\n${path}`)
      for (const f of found) console.log(`   [${f.w}px] ${f.cls}\n        "${f.text}"`)
    }
  } catch (e) {
    console.log(`\n${path} ERROR ${String(e).slice(0, 90)}`)
  }
  await page.close()
}

await browser.close()
