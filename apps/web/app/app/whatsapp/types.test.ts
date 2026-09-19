import { describe, expect, test } from "bun:test"
import { isWhatsAppSessionWindowOpen, WHATSAPP_SESSION_WINDOW_MS } from "./types"

describe("whatsapp/types session window (client-side UI mirror)", () => {
  test("open right after an inbound message", () => {
    const now = new Date("2026-01-01T00:00:00Z")
    expect(isWhatsAppSessionWindowOpen(now.toISOString(), now)).toBe(true)
  })

  test("closed exactly at the 24h boundary", () => {
    const last = new Date("2026-01-01T00:00:00Z")
    const now = new Date(last.getTime() + WHATSAPP_SESSION_WINDOW_MS)
    expect(isWhatsAppSessionWindowOpen(last.toISOString(), now)).toBe(false)
  })

  test("closed with no prior inbound message", () => {
    expect(isWhatsAppSessionWindowOpen(null)).toBe(false)
  })
})
