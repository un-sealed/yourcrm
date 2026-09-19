import { describe, expect, test } from "bun:test"
import {
  isWhatsAppSessionWindowOpen,
  whatsAppSessionWindowRemainingMs,
  WHATSAPP_SESSION_WINDOW_MS,
} from "./session-window"

const T0 = new Date("2026-01-01T00:00:00.000Z")

describe("whatsapp/session-window", () => {
  test("open immediately after an inbound message", () => {
    expect(isWhatsAppSessionWindowOpen(T0, T0)).toBe(true)
  })

  test("still open one millisecond before the 24h boundary", () => {
    const justBefore = new Date(T0.getTime() + WHATSAPP_SESSION_WINDOW_MS - 1)
    expect(isWhatsAppSessionWindowOpen(T0, justBefore)).toBe(true)
  })

  test("closed exactly at the 24h boundary (exclusive)", () => {
    const exactly24h = new Date(T0.getTime() + WHATSAPP_SESSION_WINDOW_MS)
    expect(isWhatsAppSessionWindowOpen(T0, exactly24h)).toBe(false)
  })

  test("closed one millisecond after the 24h boundary", () => {
    const justAfter = new Date(T0.getTime() + WHATSAPP_SESSION_WINDOW_MS + 1)
    expect(isWhatsAppSessionWindowOpen(T0, justAfter)).toBe(false)
  })

  test("closed with no prior inbound message at all", () => {
    expect(isWhatsAppSessionWindowOpen(null, T0)).toBe(false)
    expect(isWhatsAppSessionWindowOpen(undefined, T0)).toBe(false)
  })

  test("closed for an unparsable timestamp", () => {
    expect(isWhatsAppSessionWindowOpen("not-a-date", T0)).toBe(false)
  })

  test("accepts an ISO string the same as a Date", () => {
    const justBefore = new Date(T0.getTime() + WHATSAPP_SESSION_WINDOW_MS - 1)
    expect(isWhatsAppSessionWindowOpen(T0.toISOString(), justBefore)).toBe(true)
  })

  test("remaining time counts down to zero at the boundary and goes negative after", () => {
    expect(whatsAppSessionWindowRemainingMs(T0, T0)).toBe(WHATSAPP_SESSION_WINDOW_MS)
    expect(
      whatsAppSessionWindowRemainingMs(T0, new Date(T0.getTime() + WHATSAPP_SESSION_WINDOW_MS)),
    ).toBe(0)
    expect(
      whatsAppSessionWindowRemainingMs(T0, new Date(T0.getTime() + WHATSAPP_SESSION_WINDOW_MS + 1)),
    ).toBeLessThan(0)
  })
})
