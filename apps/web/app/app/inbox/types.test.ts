import { describe, expect, test } from "bun:test"
import {
  DEFAULT_INBOX_FILTERS,
  formatInboxTimestamp,
  INBOX_CHANNELS,
  INBOX_CHANNEL_LABELS,
  inboxChannelTone,
  inboxItemHeadline,
  inboxItemHref,
  inboxItemSubline,
  inboxQueryString,
  type InboxItem,
} from "./types"

function makeItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "email:aaaaaaaa-0000-4000-8000-000000000001",
    channel: "email",
    sourceId: "aaaaaaaa-0000-4000-8000-000000000001",
    workspaceId: "ws-1",
    sortAt: "2026-03-01T10:00:00.000Z",
    title: "Quote follow-up",
    participant: "Ada Lovelace",
    preview: "Any update on the quote?",
    direction: "inbound",
    status: "open",
    personId: null,
    companyId: null,
    dealId: null,
    ownerId: null,
    assignedTo: null,
    assignedAt: null,
    readAt: null,
    archivedAt: null,
    unread: true,
    archived: false,
    ...overrides,
  }
}

describe("inbox/link out", () => {
  test("each channel links to the module that owns the conversation", () => {
    expect(inboxItemHref({ channel: "email", sourceId: "e1" })).toBe("/app/email/e1")
    expect(inboxItemHref({ channel: "whatsapp", sourceId: "w1" })).toBe("/app/whatsapp/w1")
    expect(inboxItemHref({ channel: "call", sourceId: "c1" })).toBe("/app/calling/c1")
  })

  test("every channel has a label and a tone", () => {
    for (const channel of INBOX_CHANNELS) {
      expect(INBOX_CHANNEL_LABELS[channel]).toBeTruthy()
      expect(inboxChannelTone(channel)).toBeTruthy()
    }
  })
})

describe("inbox/row text", () => {
  test("prefers the subject, then the participant", () => {
    expect(inboxItemHeadline(makeItem())).toBe("Quote follow-up")
    expect(inboxItemHeadline(makeItem({ title: null }))).toBe("Ada Lovelace")
  })

  test("falls back to a channel description when the source has neither", () => {
    expect(inboxItemHeadline(makeItem({ channel: "call", title: null, participant: null }))).toBe(
      "Call conversation",
    )
  })

  test("blank strings do not become the headline", () => {
    expect(inboxItemHeadline(makeItem({ title: "   " }))).toBe("Ada Lovelace")
  })

  test("the subline shows the participant when the headline is the subject", () => {
    expect(inboxItemSubline(makeItem())).toBe("Ada Lovelace")
  })

  test("the subline falls back to the preview, then to a placeholder", () => {
    expect(inboxItemSubline(makeItem({ title: null }))).toBe("Any update on the quote?")
    expect(inboxItemSubline(makeItem({ title: null, preview: null }))).toBe("No preview available")
  })
})

describe("inbox/timestamps", () => {
  test("missing and unparseable timestamps render as a dash, never Invalid Date", () => {
    expect(formatInboxTimestamp(null)).toBe("—")
    expect(formatInboxTimestamp("not a date")).toBe("—")
  })

  test("a real timestamp renders as locale text", () => {
    expect(formatInboxTimestamp("2026-03-01T10:00:00.000Z")).not.toBe("—")
  })
})

describe("inbox/query string", () => {
  test("defaults send only the page size", () => {
    expect(inboxQueryString(DEFAULT_INBOX_FILTERS, null)).toBe("limit=25")
  })

  test("read state maps onto the API's unread flag in both directions", () => {
    expect(inboxQueryString({ ...DEFAULT_INBOX_FILTERS, readState: "unread" }, null)).toContain(
      "unread=true",
    )
    expect(inboxQueryString({ ...DEFAULT_INBOX_FILTERS, readState: "read" }, null)).toContain(
      "unread=false",
    )
  })

  test("assignment, channel, archived and cursor all travel to the API", () => {
    const qs = inboxQueryString(
      { channel: "whatsapp", readState: "", assigned: "me", archived: true },
      "cursor-token",
    )
    expect(qs).toContain("channel=whatsapp")
    expect(qs).toContain("assigned=me")
    expect(qs).toContain("archived=true")
    expect(qs).toContain("cursor=cursor-token")
  })

  test("anyone is the default and is not sent", () => {
    expect(inboxQueryString({ ...DEFAULT_INBOX_FILTERS, assigned: "anyone" }, null)).not.toContain(
      "assigned",
    )
  })
})
