import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * `public/sw-cache-policy.js` is a classic script (no ESM `export`) loaded
 * into the service worker via `importScripts`, so it can't be `import`ed
 * here directly. Evaluate the exact shipped file text instead — that way
 * this test can never drift from what the browser actually runs.
 */
function loadPolicy(): {
  isApiRequest: (url: URL) => boolean
  isBuildAsset: (url: URL) => boolean
} {
  const source = readFileSync(join(import.meta.dir, "..", "public", "sw-cache-policy.js"), "utf8")
  const factory = new Function(`${source}\nreturn { isApiRequest, isBuildAsset }`)
  return factory() as { isApiRequest: (url: URL) => boolean; isBuildAsset: (url: URL) => boolean }
}

describe("service worker cache policy", () => {
  test("excludes the same-origin /api/ rewrite from caching", () => {
    const { isApiRequest } = loadPolicy()
    expect(isApiRequest(new URL("http://localhost:3000/api/v1/people"))).toBe(true)
  })

  test("excludes cross-origin API calls (NEXT_PUBLIC_API_URL) from caching", () => {
    const { isApiRequest } = loadPolicy()
    expect(isApiRequest(new URL("http://localhost:4000/api/v1/deals/123"))).toBe(true)
  })

  test("does not treat ordinary navigations or static files as API requests", () => {
    const { isApiRequest } = loadPolicy()
    expect(isApiRequest(new URL("http://localhost:3000/app/people"))).toBe(false)
    expect(isApiRequest(new URL("http://localhost:3000/manifest.webmanifest"))).toBe(false)
    expect(isApiRequest(new URL("http://localhost:3000/offline.html"))).toBe(false)
  })

  test("treats hashed /_next/static/ assets as cache-first build assets", () => {
    const { isBuildAsset } = loadPolicy()
    expect(isBuildAsset(new URL("http://localhost:3000/_next/static/chunks/main.js"))).toBe(true)
  })

  test("does not treat app pages as build assets", () => {
    const { isBuildAsset } = loadPolicy()
    expect(isBuildAsset(new URL("http://localhost:3000/app/people"))).toBe(false)
  })
})
