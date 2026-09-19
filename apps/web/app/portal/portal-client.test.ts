import { describe, expect, test } from "bun:test"
import { ApiError } from "@/lib/api-client"
import {
  formatMoneyCents,
  formatPortalDate,
  invoiceTone,
  isPortalUnauthorized,
  magicLinkFeedback,
  portalErrorMessage,
  quoteTone,
  ticketTone,
  PORTAL_GENERIC_LINK_MESSAGE,
  PORTAL_RATE_LIMITED_MESSAGE,
} from "./portal-client"

describe("web/portal: the login page cannot leak who has an account", () => {
  const outcomes: [string, unknown][] = [
    ["a successful request", null],
    ["a 404 from the API", new ApiError("NOT_FOUND", "not found", 404)],
    ["a validation error", new ApiError("VALIDATION_ERROR", "bad email", 400)],
    ["a server error", new ApiError("INTERNAL_ERROR", "boom", 500)],
    ["a network failure", new TypeError("Failed to fetch")],
  ]

  for (const [name, error] of outcomes) {
    test(`${name} shows the same message`, () => {
      expect(magicLinkFeedback(error)).toBe(PORTAL_GENERIC_LINK_MESSAGE)
    })
  }

  test("only an explicit rate limit says something different — and it says nothing about the address", () => {
    const message = magicLinkFeedback(new ApiError("RATE_LIMITED", "slow down", 429))
    expect(message).toBe(PORTAL_RATE_LIMITED_MESSAGE)
    expect(message.toLowerCase()).not.toContain("account")
    expect(message.toLowerCase()).not.toContain("email address has")
  })

  test("the generic message never confirms or denies an account", () => {
    expect(PORTAL_GENERIC_LINK_MESSAGE).toContain("If that email address has portal access")
    expect(PORTAL_GENERIC_LINK_MESSAGE.toLowerCase()).not.toContain("no account")
    expect(PORTAL_GENERIC_LINK_MESSAGE.toLowerCase()).not.toContain("not found")
  })
})

describe("web/portal: error phrasing", () => {
  test("a 404 reads as unavailable, never as 'belongs to someone else'", () => {
    const message = portalErrorMessage(new ApiError("NOT_FOUND", "invoice not found", 404))
    expect(message).toBe("That item is not available.")
    expect(message.toLowerCase()).not.toContain("permission")
    expect(message.toLowerCase()).not.toContain("forbidden")
  })

  test("a 401 sends the customer back to sign in", () => {
    expect(isPortalUnauthorized(new ApiError("UNAUTHORIZED", "nope", 401))).toBe(true)
    expect(portalErrorMessage(new ApiError("UNAUTHORIZED", "nope", 401))).toContain("sign in")
  })

  test("an unknown failure is generic", () => {
    expect(portalErrorMessage(new Error("kaboom"))).toBe("Something went wrong. Please try again.")
    expect(isPortalUnauthorized(new Error("kaboom"))).toBe(false)
  })
})

describe("web/portal: formatting", () => {
  test("money renders from integer minor units", () => {
    expect(formatMoneyCents(123_456, "USD")).toBe("$1,234.56")
    expect(formatMoneyCents(0, "USD")).toBe("$0.00")
  })

  test("an unknown currency degrades instead of throwing", () => {
    expect(formatMoneyCents(1_000, "NOTACURRENCY")).toBe("10.00 NOTACURRENCY")
  })

  test("dates render or fall back to an em dash", () => {
    expect(formatPortalDate("2026-03-04T00:00:00.000Z")).toContain("2026")
    expect(formatPortalDate(null)).toBe("—")
    expect(formatPortalDate("not a date")).toBe("—")
  })

  test("status tones", () => {
    expect(invoiceTone({ status: "paid", overdue: false })).toBe("success")
    expect(invoiceTone({ status: "sent", overdue: true })).toBe("destructive")
    expect(invoiceTone({ status: "sent", overdue: false })).toBe("info")
    expect(quoteTone("accepted")).toBe("success")
    expect(quoteTone("rejected")).toBe("destructive")
    expect(ticketTone("closed")).toBe("success")
    expect(ticketTone("pending")).toBe("warning")
    expect(ticketTone("open")).toBe("info")
  })
})
