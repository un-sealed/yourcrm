import { describe, expect, test } from "bun:test"
import { toWhatsAppLink } from "./whatsapp-link"

describe("people/toWhatsAppLink", () => {
  test("strips formatting characters, keeping the country code digits", () => {
    expect(toWhatsAppLink("+1 (555) 123-4567")).toBe("https://wa.me/15551234567")
  })

  test("passes through an already-bare digit string", () => {
    expect(toWhatsAppLink("15551234567")).toBe("https://wa.me/15551234567")
  })

  test("returns null when there are no digits to link to", () => {
    expect(toWhatsAppLink("n/a")).toBeNull()
  })
})
