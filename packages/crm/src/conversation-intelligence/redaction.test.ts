import { describe, expect, test } from "bun:test"
import {
  containsConversationContent,
  containsConversationTerms,
  redactConversationContent,
  redactConversationTerms,
  MIN_TERM_LENGTH,
  REDACTED_MESSAGE_MAX_CHARS,
  REDACTION_PLACEHOLDER,
  REDACTION_WINDOW,
} from "./redaction"

/**
 * PROPERTY 4 — PII STAYS PUT, at the level of the pure redactor. The
 * service-level proof (a provider error carrying transcript text reaches
 * neither the stored row nor the audit trail nor the thrown error) lives
 * in `service.test.ts`.
 */

const TRANSCRIPT = [
  "Maria Sanchez: Hi, this is Maria calling about invoice 4451-A for the Halifax site.",
  "Rep: Of course. I can see the balance is £12,400 and it went out on the 3rd.",
  "Maria Sanchez: My husband is in hospital this month so I need to push the payment to the 20th.",
  "Rep: That's no problem at all, I'll note it.",
].join("\n")

describe("conversation-intelligence/redaction", () => {
  test("a provider error quoting the transcript comes back clean", () => {
    const raw = `400 invalid_request: the model could not process the input — "${TRANSCRIPT}"`
    const redacted = redactConversationContent(raw, TRANSCRIPT)
    expect(redacted).toContain("400 invalid_request")
    expect(redacted).toContain(REDACTION_PLACEHOLDER)
    expect(redacted).not.toContain("Maria Sanchez")
    expect(redacted).not.toContain("invoice 4451-A")
    expect(redacted).not.toContain("hospital")
    expect(containsConversationContent(redacted, TRANSCRIPT)).toBe(false)
  })

  test("a fragment quoted from the middle is removed too", () => {
    const raw = `context overflow near: ${TRANSCRIPT.slice(120, 260)}`
    const redacted = redactConversationContent(raw, TRANSCRIPT)
    expect(containsConversationContent(redacted, TRANSCRIPT)).toBe(false)
    expect(redacted.startsWith("context overflow near: ")).toBe(true)
  })

  test("the whole quotation goes, not just its first window", () => {
    const quote = TRANSCRIPT.slice(0, 200)
    const redacted = redactConversationContent(`upstream said: ${quote} <end>`, TRANSCRIPT)
    expect(redacted).toBe(`upstream said: ${REDACTION_PLACEHOLDER} <end>`)
  })

  test("ordinary error prose survives untouched", () => {
    const raw = "AI_PROVIDER_TIMEOUT: the request timed out after 60000 ms"
    expect(redactConversationContent(raw, TRANSCRIPT)).toBe(raw)
  })

  test("several sources are all redacted in one pass", () => {
    const other = "Second conversation about the renewal discount for Northwind Ltd 2026"
    const raw = `failed: ${TRANSCRIPT.slice(0, 80)} and also ${other}`
    const redacted = redactConversationContent(raw, TRANSCRIPT, other)
    expect(containsConversationContent(redacted, TRANSCRIPT, other)).toBe(false)
  })

  test("the result is capped so an error cannot overflow the column", () => {
    const redacted = redactConversationContent("e".repeat(50_000), TRANSCRIPT)
    expect(redacted.length).toBeLessThanOrEqual(REDACTED_MESSAGE_MAX_CHARS)
  })

  test("a runaway provider reply cannot be used to burn CPU", () => {
    const started = Date.now()
    redactConversationContent("f".repeat(1_000_000), "g".repeat(200_000))
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("content shorter than the window is left alone, and that is documented", () => {
    // A 10-character "conversation" would make the redactor match ordinary
    // prose. Below the window we deliberately do nothing.
    expect("tiny".length).toBeLessThan(REDACTION_WINDOW)
    expect(redactConversationContent("failed on tiny", "tiny")).toBe("failed on tiny")
  })

  test("containsConversationContent is the honest inverse", () => {
    expect(containsConversationContent(TRANSCRIPT.slice(30, 90), TRANSCRIPT)).toBe(true)
    expect(containsConversationContent("nothing to see here", TRANSCRIPT)).toBe(false)
    expect(containsConversationContent("", TRANSCRIPT)).toBe(false)
  })

  test("participant names are removed by the exact-term rule, not the window", () => {
    // "Maria Sanchez" is 13 characters — under the quotation window, and
    // exactly the kind of thing that must not reach an audit row.
    const raw = "400: Maria Sanchez could not be processed by the model"
    expect(redactConversationContent(raw, TRANSCRIPT)).toContain("Maria Sanchez")
    const withTerms = redactConversationTerms(raw, ["Maria Sanchez", "Rep"])
    expect(withTerms).not.toContain("Maria Sanchez")
    expect(containsConversationTerms(withTerms, ["Maria Sanchez"])).toBe(false)
  })

  test("longer terms are removed before their prefixes", () => {
    expect(redactConversationTerms("hi Maria Sanchez", ["Maria", "Maria Sanchez"])).toBe(
      `hi ${REDACTION_PLACEHOLDER}`,
    )
  })

  test("very short terms are ignored so ordinary prose survives", () => {
    expect(MIN_TERM_LENGTH).toBe(4)
    expect(redactConversationTerms("a timeout occurred", ["a", "an"])).toBe("a timeout occurred")
    expect(containsConversationTerms("a timeout occurred", ["a"])).toBe(false)
  })

  test("null and undefined sources are ignored, not crashed on", () => {
    expect(redactConversationContent("plain", null, undefined)).toBe("plain")
    expect(containsConversationContent("plain", null, undefined)).toBe(false)
  })
})
