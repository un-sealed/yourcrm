// TEMPORARY consistency harness — delete after the review run.
import { chromium } from "@playwright/test"

const BASE = process.env.REVIEW_BASE ?? "http://localhost:3000"
const API = process.env.REVIEW_API ?? "http://localhost:4000"

const PAGES = (
  process.env.REVIEW_PAGES ??
  [
    "/app/dashboard",
    "/app/people",
    "/app/companies",
    "/app/deals",
    "/app/tasks",
    "/app/activities",
    "/app/leads",
    "/app/quotes",
    "/app/invoices",
    "/app/products",
    "/app/tickets",
    "/app/calling",
    "/app/knowledge-base",
    "/app/automation",
    "/app/sequences",
    "/app/reports",
    "/app/dashboards",
    "/app/custom-objects",
    "/app/pipelines",
    "/app/files",
    "/app/forms",
    "/app/marketplace",
    "/app/integrations",
    "/app/api-webhooks",
    "/app/import-export",
    "/app/settings",
    "/app/inbox",
    "/app/whatsapp",
    "/app/calendar",
    "/app/email",
    "/app/marketing",
    "/app/marketing/campaigns",
    "/app/marketing/segments",
    "/app/customer-success",
    "/app/booking-links",
    "/app/conversation-intelligence",
    "/app/ai",
    "/app/ai/agents",
    "/app/notifications",
    "/app/search",
  ]
)

async function main() {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const login = await context.request.post(`${API}/api/v1/auth/login`, {
    data: { email: "admin@yourcrm.local", password: "Password123!" },
  })
  if (login.status() !== 200) throw new Error(`login failed: ${login.status()}`)

  const rows = []
  for (const path of PAGES) {
    const page = await context.newPage()
    try {
      const resp = await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 30_000 })
      await page.waitForTimeout(300)
      const info = await page.evaluate(() => {
        const h1 = document.querySelector("h1")
        const h1cs = h1 ? getComputedStyle(h1) : null
        const inScrollParent = (el) => {
          for (let p = el.parentElement; p; p = p.parentElement) {
            const cs = getComputedStyle(p)
            if (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1) return true
          }
          return false
        }
        let pageOverflow = 0
        const realOffenders = []
        for (const el of document.querySelectorAll("body *")) {
          const r = el.getBoundingClientRect()
          if (r.width === 0 || r.height === 0) continue
          if (r.right > document.documentElement.clientWidth + 1) {
            pageOverflow = Math.max(pageOverflow, Math.round(r.right - document.documentElement.clientWidth))
            if (!inScrollParent(el) && realOffenders.length < 3) {
              realOffenders.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ").slice(0, 3).join(".")}`)
            }
          }
        }
        // Surface rhythm: bordered boxes on the page.
        const radii = {}
        const shadows = {}
        for (const el of document.querySelectorAll("main *")) {
          const cs = getComputedStyle(el)
          if (cs.borderTopWidth === "0px") continue
          radii[cs.borderTopLeftRadius] = (radii[cs.borderTopLeftRadius] ?? 0) + 1
          const sh = cs.boxShadow === "none" ? "none" : "shadow"
          shadows[sh] = (shadows[sh] ?? 0) + 1
        }
        return {
          h1Text: h1?.textContent?.trim().slice(0, 40) ?? null,
          h1Size: h1cs?.fontSize ?? null,
          h1Weight: h1cs?.fontWeight ?? null,
          h1Tracking: h1cs?.letterSpacing ?? null,
          h1Family: h1cs?.fontFamily?.split(",")[0] ?? null,
          radii,
          shadows,
          realOffenders,
          pageOverflow,
          mainPaddingX: (() => {
            const m = document.querySelector("main")
            if (!m) return null
            const cs = getComputedStyle(m)
            return `${cs.paddingLeft}/${cs.paddingRight}`
          })(),
        }
      })
      rows.push({ path, status: resp?.status(), ...info })
    } catch (e) {
      rows.push({ path, status: "ERR", navError: String(e).slice(0, 120) })
    }
    await page.close()
  }

  console.log(JSON.stringify(rows, null, 1))
  await browser.close()
}

main().catch((e) => {
  console.error("FAILED:", e)
  process.exit(1)
})
