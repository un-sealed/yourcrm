import { describe, expect, test } from "bun:test"
import {
  isPublicPortalComment,
  toPortalInvoiceDetail,
  toPortalInvoiceSummary,
  toPortalQuoteDetail,
  toPortalTicketDetail,
  toPortalTicketSummary,
  PORTAL_FORBIDDEN_KEYS,
} from "./redact"
import type { PortalSourceRecord } from "./types"

/**
 * Redaction tests.
 *
 * These feed each projector a source row that is deliberately CONTAMINATED:
 * every internal column the CRM has, plus a few it does not, plus a field
 * nobody has invented yet. The assertions are on the exact key set of the
 * output, so adding a field to a DTO is a conscious act that updates a test,
 * and a pass-through spread (`{ ...source }`) fails immediately.
 */

const contaminated = {
  id: "record-1",
  number: "INV-1",
  status: "sent",
  currency: "EUR",
  issueDate: "2026-01-01",
  dueDate: "2026-02-01",
  totalCents: 10_000,
  paidCents: 4_000,
  // Everything below is internal and must not survive.
  notes: "chase this one, they always pay late",
  internalNotes: "flagged by finance",
  ownerId: "member-9",
  personId: "person-9",
  companyId: "company-9",
  dealId: "deal-9",
  quoteId: "quote-9",
  workspaceId: "ws-9",
  createdBy: "member-9",
  updatedBy: "member-9",
  deletedAt: null,
  auditEvents: [{ action: "update" }],
  customFields: { internalScore: 42 },
  somethingInventedLater: "should not appear either",
} satisfies PortalSourceRecord

describe("crm/portal/redact: invoices", () => {
  test("a summary exposes exactly the customer-facing fields", () => {
    const dto = toPortalInvoiceSummary(contaminated, new Date("2026-03-01T00:00:00Z"))
    expect(Object.keys(dto).sort()).toEqual([
      "amountPaidCents",
      "balanceDueCents",
      "currency",
      "dueDate",
      "id",
      "issueDate",
      "lineItems",
      "number",
      "overdue",
      "status",
      "totalCents",
    ])
    for (const key of PORTAL_FORBIDDEN_KEYS) {
      expect(key in dto).toBe(false)
    }
    expect(JSON.stringify(dto)).not.toContain("chase this one")
  })

  test("balance due and overdue are derived, not taken from the row", () => {
    const dto = toPortalInvoiceSummary(
      { ...contaminated, balanceDueCents: -1, overdue: false },
      new Date("2026-03-01T00:00:00Z"),
    )
    expect(dto.totalCents).toBe(10_000)
    expect(dto.amountPaidCents).toBe(4_000)
    expect(dto.balanceDueCents).toBe(6_000)
    expect(dto.overdue).toBe(true)
  })

  test("a detail recomputes totals from line items and the payments aggregate", () => {
    const dto = toPortalInvoiceDetail(
      contaminated,
      [
        {
          id: "li-1",
          description: "Setup",
          quantity: 2,
          unitAmountCents: 1_500,
          notes: "internal",
        },
        { id: "li-2", description: "Support", quantity: 1, unitAmountCents: 7_000 },
      ],
      4_000,
      new Date("2026-01-15T00:00:00Z"),
    )
    expect(dto.totalCents).toBe(10_000)
    expect(dto.amountPaidCents).toBe(4_000)
    expect(dto.balanceDueCents).toBe(6_000)
    expect(dto.overdue).toBe(false)
    expect(dto.lineItems.map((item) => Object.keys(item).sort())).toEqual([
      ["amountCents", "description", "id", "quantity", "unitAmountCents"],
      ["amountCents", "description", "id", "quantity", "unitAmountCents"],
    ])
    expect(JSON.stringify(dto.lineItems)).not.toContain("internal")
  })
})

describe("crm/portal/redact: quotes", () => {
  test("terms survive, notes do not, and totals follow the quotes module's math", () => {
    const dto = toPortalQuoteDetail(
      {
        ...contaminated,
        terms: "Payable within 30 days.",
        discountType: "percent",
        discountValue: 1000,
        taxRateBps: 2000,
        expiresAt: "2026-04-01",
      },
      [{ id: "qli-1", description: "License", quantity: 10, unitAmountCents: 1_000 }],
    )
    expect(dto.terms).toBe("Payable within 30 days.")
    expect(dto.subtotalCents).toBe(10_000)
    expect(dto.discountCents).toBe(1_000)
    expect(dto.taxCents).toBe(1_800)
    expect(dto.grandTotalCents).toBe(10_800)
    expect(Object.keys(dto).sort()).toEqual([
      "currency",
      "discountCents",
      "expiresAt",
      "grandTotalCents",
      "id",
      "lineItems",
      "number",
      "status",
      "subtotalCents",
      "taxCents",
      "terms",
    ])
    expect(JSON.stringify(dto)).not.toContain("chase this one")
  })
})

describe("crm/portal/redact: ticket comment visibility fails closed", () => {
  const cases: [string, PortalSourceRecord, boolean][] = [
    ["visibility public", { id: "1", visibility: "public" }, true],
    ["visibility PUBLIC (case)", { id: "1", visibility: "PUBLIC" }, true],
    ["visibility internal", { id: "1", visibility: "internal" }, false],
    ["visibility private", { id: "1", visibility: "private" }, false],
    ["visibility misspelled", { id: "1", visibility: "publik" }, false],
    ["no visibility at all", { id: "1" }, false],
    ["visibility null", { id: "1", visibility: null }, false],
    ["visibility numeric", { id: "1", visibility: 1 }, false],
    ["isInternal false", { id: "1", isInternal: false }, true],
    ["isInternal true", { id: "1", isInternal: true }, false],
    ["isInternal as the string 'false'", { id: "1", isInternal: "false" }, false],
    ["internal false", { id: "1", internal: false }, true],
  ]

  for (const [name, source, expected] of cases) {
    test(`${name} -> ${expected ? "public" : "internal"}`, () => {
      expect(isPublicPortalComment(source)).toBe(expected)
    })
  }

  test("a ticket detail keeps only comments that proved themselves public", () => {
    const dto = toPortalTicketDetail(
      {
        id: "ticket-1",
        subject: "Broken widget",
        status: "open",
        priority: "high",
        assigneeId: "member-9",
        internalRating: 5,
        slaBreached: true,
      },
      [
        { id: "c1", body: "Replacement shipped.", visibility: "public", authorName: "Sam" },
        { id: "c2", body: "Do not refund, see CRM note.", visibility: "internal" },
        { id: "c3", body: "No visibility field, assume internal." },
      ],
    )
    expect(dto.comments.map((comment) => comment.id)).toEqual(["c1"])
    expect(Object.keys(dto).sort()).toEqual([
      "comments",
      "createdAt",
      "id",
      "priority",
      "status",
      "subject",
      "updatedAt",
    ])
    const serialized = JSON.stringify(dto)
    expect(serialized).not.toContain("Do not refund")
    expect(serialized).not.toContain("assume internal")
    expect(serialized).not.toContain("member-9")
    expect(serialized).not.toContain("slaBreached")
  })

  test("ticket summaries accept either naming convention for the subject", () => {
    expect(toPortalTicketSummary({ id: "t", title: "From title" }).subject).toBe("From title")
    expect(toPortalTicketSummary({ id: "t", subject: "From subject" }).subject).toBe("From subject")
  })

  test("Date instances become ISO strings", () => {
    const dto = toPortalTicketSummary({ id: "t", createdAt: new Date("2026-02-02T03:04:05Z") })
    expect(dto.createdAt).toBe("2026-02-02T03:04:05.000Z")
  })
})
