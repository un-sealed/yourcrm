// TEMPORARY review harness — deleted after the audit run.
import { chromium } from "@playwright/test"

const BASE = process.env.REVIEW_BASE ?? "http://localhost:3000"
const API = process.env.REVIEW_API ?? "http://localhost:4000"

const PAGES = (process.env.REVIEW_PAGES
  ? process.env.REVIEW_PAGES.split(",")
  : [
      "/app/dashboard",
      "/app/people",
      "/app/companies",
      "/app/deals",
      "/app/tasks",
      "/app/activities",
      "/app/quotes",
      "/app/invoices",
      "/app/tickets",
      "/app/settings",
      "/app/reports",
      "/app/custom-objects",
      "/app/search",
      "/app/notifications",
    ])

const IGNORE = [/favicon/i, /manifest/i, /service-worker/i, /sw\.js/i, /_next\/static/i, /hot-update/i]

function interesting(text) {
  return !IGNORE.some((re) => re.test(text))
}

async function inspect(page) {
  return page.evaluate(() => {
    const doc = document.documentElement
    const overflow = doc.scrollWidth - doc.clientWidth

    // Elements wider than the viewport (excluding scroll containers).
    const offenders = []
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.right > doc.clientWidth + 1 && r.width < doc.clientWidth * 3) {
        const style = getComputedStyle(el)
        if (style.position === "fixed" || style.position === "absolute") continue
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || "").toString().slice(0, 80),
          right: Math.round(r.right),
        })
      }
      if (offenders.length > 5) break
    }

    const brokenImages = Array.from(document.images)
      .filter((img) => img.complete && img.naturalWidth === 0)
      .map((img) => img.currentSrc || img.src)

    const cs = getComputedStyle(document.documentElement)
    const aside = document.querySelector("aside")
    const header = document.querySelector("header")

    return {
      overflow,
      offenders,
      brokenImages,
      h1Count: document.querySelectorAll("h1").length,
      tokens: {
        sidebar: cs.getPropertyValue("--sidebar").trim(),
        primary: cs.getPropertyValue("--primary").trim(),
        background: cs.getPropertyValue("--background").trim(),
      },
      asideBg: aside ? getComputedStyle(aside).backgroundColor : null,
      asideColor: aside ? getComputedStyle(aside).color : null,
      asideWidth: aside ? Math.round(aside.getBoundingClientRect().width) : null,
      shadowProbe: (() => {
        const out = {}
        for (const cls of ["shadow-xs", "shadow-panel", "shadow-pop", "shadow-md", "shadow-lg"]) {
          const el = document.createElement("div")
          el.className = cls
          document.body.appendChild(el)
          out[cls] = getComputedStyle(el).boxShadow
          el.remove()
        }
        return out
      })(),
      shadowRules: (() => {
        const found = []
        for (const sheet of Array.from(document.styleSheets)) {
          let rules
          try {
            rules = sheet.cssRules
          } catch {
            continue
          }
          for (const rule of Array.from(rules ?? [])) {
            const sel = rule.selectorText
            if (sel && /shadow-(xs|card|pop)\b/.test(sel)) found.push(rule.cssText.slice(0, 260))
          }
        }
        return found.slice(0, 6)
      })(),
      headerPosition: header ? getComputedStyle(header).position : null,
      bodyFont: getComputedStyle(document.body).fontFamily,
      navLinks: document.querySelectorAll("aside nav a").length,
    }
  })
}

async function main() {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })

  // Log in through the API; the context's cookie jar carries the session
  // into page navigations because both are on host `localhost`.
  const login = await context.request.post(`${API}/api/v1/auth/login`, {
    data: { email: "admin@yourcrm.local", password: "Password123!" },
  })
  console.log("login status:", login.status())

  const report = {}
  for (const path of PAGES) {
    const page = await context.newPage()
    const consoleIssues = []
    const pageErrors = []
    const failed = []
    page.on("console", (m) => {
      if ((m.type() === "error" || m.type() === "warning") && interesting(m.text())) {
        consoleIssues.push(`${m.type()}: ${m.text()}`.slice(0, 220))
      }
    })
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 220)))
    page.on("requestfailed", (r) => {
      if (interesting(r.url())) failed.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`)
    })
    page.on("response", (r) => {
      if (r.status() >= 400 && interesting(r.url())) failed.push(`${r.status()} ${r.request().method()} ${r.url()}`)
    })

    let status = null
    try {
      const resp = await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 30_000 })
      status = resp?.status() ?? null
      await page.waitForTimeout(600)
    } catch (e) {
      report[path] = { status, navError: String(e).slice(0, 200) }
      await page.close()
      continue
    }

    const info = await inspect(page)
    report[path] = {
      status,
      ...info,
      console: consoleIssues.slice(0, 6),
      pageErrors: pageErrors.slice(0, 4),
      failedRequests: failed.slice(0, 5),
    }
    await page.close()
  }

  // Mobile pass on two pages.
  const mobile = {}
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await mctx.request.post(`${API}/api/v1/auth/login`, {
    data: { email: "admin@yourcrm.local", password: "Password123!" },
  })
  for (const path of ["/app/dashboard", "/app/people"]) {
    const page = await mctx.newPage()
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => {})
    await page.waitForTimeout(400)
    mobile[path] = await page.evaluate(() => {
      const doc = document.documentElement
      const bottomNav = document.querySelector('nav[aria-label="Primary"]')
      const aside = document.querySelector("aside")
      return {
        overflow: doc.scrollWidth - doc.clientWidth,
        asideVisible: aside ? getComputedStyle(aside).display !== "none" : false,
        bottomNavVisible: bottomNav ? getComputedStyle(bottomNav).display !== "none" : false,
      }
    })
    await page.close()
  }
  report.__mobile = mobile

  console.log(JSON.stringify(report, null, 2))
  await browser.close()
}

main().catch((e) => {
  console.error("REVIEW FAILED:", e)
  process.exit(1)
})
