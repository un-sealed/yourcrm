// TEMPORARY probe — delete after the review run.
import { chromium } from "@playwright/test"

const BASE = "http://localhost:3000"
const API = "http://localhost:4000"
const PATHS = (process.env.PROBE_PAGES ?? "/app/people,/app/tickets,/app/email").split(",")

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.request.post(`${API}/api/v1/auth/login`, {
  data: { email: "admin@yourcrm.local", password: "Password123!" },
})

for (const path of PATHS) {
  const page = await context.newPage()
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 30_000 })
  await page.waitForTimeout(400)
  const out = await page.evaluate(() => {
    const docEl = document.documentElement
    const vw = docEl.clientWidth
    const items = []
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.right <= vw + 1) continue
      const cs = getComputedStyle(el)
      // Find the nearest ancestor that clips horizontally.
      let clipper = null
      for (let p = el.parentElement; p; p = p.parentElement) {
        const pcs = getComputedStyle(p)
        if (/(hidden|clip|auto|scroll)/.test(pcs.overflowX)) {
          clipper = {
            tag: p.tagName.toLowerCase(),
            cls: (p.className || "").toString().slice(0, 70),
            overflowX: pcs.overflowX,
            scrollW: p.scrollWidth,
            clientW: p.clientWidth,
          }
          break
        }
      }
      items.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || "").toString().slice(0, 90),
        right: Math.round(r.right),
        width: Math.round(r.width),
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
        position: cs.position,
        offsetParentNull: el.offsetParent === null,
        text: (el.textContent || "").trim().slice(0, 40),
        clipper,
      })
      if (items.length > 8) break
    }
    return {
      vw,
      docScrollW: docEl.scrollWidth,
      docScrollH: docEl.scrollHeight,
      bodyScrollW: document.body.scrollWidth,
      overflowingElements: items,
    }
  })
  console.log(`\n=== ${path} ===`)
  console.log(JSON.stringify(out, null, 1))
  await page.close()
}

await browser.close()
