import { describe, expect, test } from "bun:test"
import { InvalidPhoneNumberError, isE164, normalizeE164 } from "./phone"

describe("calling/phone", () => {
  test("a value already in E.164 form is preserved once punctuation is stripped", () => {
    expect(normalizeE164("+14155550123")).toBe("+14155550123")
    expect(normalizeE164("+1 (415) 555-0123")).toBe("+14155550123")
    expect(normalizeE164(" +91 98765 43210 ")).toBe("+919876543210")
  })

  test("00 international prefix is treated as +", () => {
    expect(normalizeE164("0044 20 7946 0958")).toBe("+442079460958")
  })

  test("a bare national number needs an explicit default calling code", () => {
    expect(normalizeE164("4155550123", { defaultCountryCallingCode: "1" })).toBe("+14155550123")
    expect(normalizeE164("9876543210", { defaultCountryCallingCode: "91" })).toBe("+919876543210")
  })

  test("a bare national number with no default calling code is rejected, not guessed", () => {
    expect(() => normalizeE164("4155550123")).toThrow(InvalidPhoneNumberError)
  })

  test("rejects empty, too-short and too-long values", () => {
    expect(() => normalizeE164("")).toThrow(InvalidPhoneNumberError)
    expect(() => normalizeE164("   ")).toThrow(InvalidPhoneNumberError)
    expect(() => normalizeE164("+123")).toThrow(InvalidPhoneNumberError)
    expect(() => normalizeE164("+1234567890123456")).toThrow(InvalidPhoneNumberError)
  })

  test("rejects non-numeric garbage", () => {
    expect(() => normalizeE164("not-a-number")).toThrow(InvalidPhoneNumberError)
  })

  test("isE164 recognises normalised values only", () => {
    expect(isE164("+14155550123")).toBe(true)
    expect(isE164("14155550123")).toBe(false)
    expect(isE164("+1 415 555 0123")).toBe(false)
  })
})
