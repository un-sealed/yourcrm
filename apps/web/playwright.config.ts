import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
  },
  // Phase 0 assumes `bun run dev` (or start) is already running, plus the API
  // on :4000 — CI will start them (see Phase 0b CI agent). No webServer block
  // yet so local runs stay explicit: `bun run dev & bunx playwright test`.
})
