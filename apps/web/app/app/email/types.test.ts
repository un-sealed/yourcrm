import { describe, expect, test } from "bun:test"
import {
  emailParticipantLabel,
  emailRecipientsLine,
  emailSenderLabel,
  emailStatusTone,
  emailThreadTitle,
  formatEmailTimestamp,
  parseEmailRecipients,
  type EmailMessageDetailResponse,
} from "./types"

function participant(role: string, address: string, displayName: string | null = null) {
  return { id: `p-${address}-${role}`, role, address, displayName, personId: null }
}

describe("email/web/labels", () => {
  test("a blank subject reads as (no subject)", () => {
    expect(emailThreadTitle({ subject: "Q3" })).toBe("Q3")
    expect(emailThreadTitle({ subject: "   " })).toBe("(no subject)")
    expect(emailThreadTitle({ subject: null })).toBe("(no subject)")
  })

  test("participants render as name + address when a name exists", () => {
    expect(emailParticipantLabel(participant("from", "ada@example.com", "Ada"))).toBe(
      "Ada <ada@example.com>",
    )
    expect(emailParticipantLabel(participant("from", "ada@example.com"))).toBe("ada@example.com")
  })

  test("recipient lines only include the requested role", () => {
    const participants = [
      participant("from", "sales@yourcrm.test"),
      participant("to", "ada@example.com"),
      participant("to", "bob@example.com"),
      participant("cc", "cfo@yourcrm.test"),
    ]
    expect(emailRecipientsLine(participants, "to")).toBe("ada@example.com, bob@example.com")
    expect(emailRecipientsLine(participants, "cc")).toBe("cfo@yourcrm.test")
    expect(emailRecipientsLine(participants, "bcc")).toBe("")
  })

  test("the sender falls back to the message columns", () => {
    const base: EmailMessageDetailResponse = {
      message: {
        id: "m1",
        threadId: "t1",
        direction: "inbound",
        status: "received",
        subject: "hi",
        fromAddress: "ada@example.com",
        fromName: "Ada",
        bodyText: "hi",
        snippet: "hi",
        providerMessageId: null,
        sentAt: null,
        receivedAt: null,
        lastError: null,
        createdAt: "2026-03-01T10:00:00.000Z",
      },
      participants: [],
      attachments: [],
    }
    expect(emailSenderLabel(base)).toBe("Ada <ada@example.com>")
    expect(
      emailSenderLabel({ ...base, participants: [participant("from", "zoe@x.test", "Zoe")] }),
    ).toBe("Zoe <zoe@x.test>")
  })

  test("status tones pair colour with the status text", () => {
    expect(emailStatusTone("sent")).toBe("success")
    expect(emailStatusTone("received")).toBe("success")
    expect(emailStatusTone("queued")).toBe("warning")
    expect(emailStatusTone("bounced")).toBe("destructive")
    expect(emailStatusTone("unknown")).toBe("secondary")
  })

  test("timestamps degrade gracefully", () => {
    expect(formatEmailTimestamp(null)).toBe("—")
    expect(formatEmailTimestamp("not a date")).toBe("not a date")
    expect(formatEmailTimestamp("2026-03-01T10:00:00.000Z")).not.toBe("—")
  })
})

describe("email/web/recipients", () => {
  test("splits on commas, semicolons and whitespace and lowercases", () => {
    expect(
      parseEmailRecipients("Ada@Example.com, bob@example.com; carol@example.com").valid,
    ).toEqual([
      { address: "ada@example.com" },
      { address: "bob@example.com" },
      { address: "carol@example.com" },
    ])
  })

  test("de-duplicates repeated recipients", () => {
    expect(parseEmailRecipients("ada@example.com, ADA@example.com").valid).toHaveLength(1)
  })

  test("reports invalid entries instead of sending them", () => {
    const result = parseEmailRecipients("ada@example.com, nope, @bad")
    expect(result.valid).toEqual([{ address: "ada@example.com" }])
    expect(result.invalid).toEqual(["nope", "@bad"])
  })

  test("an empty box yields no recipients and no errors", () => {
    expect(parseEmailRecipients("   ")).toEqual({ valid: [], invalid: [] })
  })
})
