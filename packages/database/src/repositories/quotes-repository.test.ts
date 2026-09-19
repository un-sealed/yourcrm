import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import { quoteLineItems, quotes, type Quote } from "../schema/quotes"
import {
  createQuotesRepository,
  normalizeCurrency,
  normalizeQuoteNumber,
} from "./quotes-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const QUOTE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const MIGRATION = new URL("../../migrations/0130_quotes.sql", import.meta.url)

/** Thenable chain stub: every query builder call returns the proxy; each await pops one result. */
function mockDb(queued: unknown[][] = []) {
  let step = 0
  const proxy = new Proxy(function () {}, {
    get(_target, prop: string | symbol) {
      if (prop === "then") {
        return (resolve: (value: unknown) => void) => {
          resolve(queued[step] ?? [])
          step += 1
        }
      }
      return (..._args: unknown[]) => proxy
    },
  })
  return proxy as unknown as Database
}

function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    id: QUOTE_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    ownerId: null,
    number: "Q-001",
    status: "draft",
    currency: "USD",
    expiresAt: null,
    companyId: null,
    personId: null,
    dealId: null,
    discountType: "none",
    discountValue: 0,
    taxRateBps: 0,
    terms: null,
    notes: null,
    ...overrides,
  }
}

describe("quotes/schema", () => {
  test("quotes expose the BaseRecord column contract", () => {
    const cols = quotes as unknown as Record<string, unknown>
    for (const col of ["id", "workspaceId", "createdAt", "updatedAt", "deletedAt"]) {
      expect(cols[col], col).toBeDefined()
    }
    expect(cols.number).toBeDefined()
    expect(cols.companyId).toBeDefined()
    expect(cols.personId).toBeDefined()
    expect(cols.dealId).toBeDefined()
    expect(cols.ownerId).toBeDefined()
    expect(cols.discountType).toBeDefined()
    expect(cols.discountValue).toBeDefined()
    expect(cols.taxRateBps).toBeDefined()
  })

  test("line items carry a quote FK, plain product ref, plus workspace scoping", () => {
    const cols = quoteLineItems as unknown as Record<string, unknown>
    expect(cols.quoteId).toBeDefined()
    expect(cols.productId).toBeDefined()
    expect(cols.workspaceId).toBeDefined()
    expect(cols.unitAmountCents).toBeDefined()
    expect(cols.quantity).toBeDefined()
  })
})

describe("quotes/validation", () => {
  test("numbers trim and collapse whitespace", () => {
    expect(normalizeQuoteNumber("  Q-  001 ")).toBe("Q- 001")
  })

  test("numbers reject empty and overlong values", () => {
    expect(() => normalizeQuoteNumber("   ")).toThrow()
    expect(() => normalizeQuoteNumber("x".repeat(65))).toThrow()
  })

  test("currency defaults to USD and validates shape", () => {
    expect(normalizeCurrency(undefined)).toBe("USD")
    expect(normalizeCurrency("eur")).toBe("EUR")
    expect(() => normalizeCurrency("dollars")).toThrow()
  })
})

describe("quotes/repository", () => {
  test("create returns the inserted row", async () => {
    const repo = createQuotesRepository()
    const row = makeQuote()
    const result = await repo.create(mockDb([[row]]), WS, { number: "Q-001" })
    expect(result).toBe(row)
  })

  test("create rejects empty numbers before touching the db", async () => {
    const repo = createQuotesRepository()
    await expect(repo.create(mockDb(), WS, { number: "  " })).rejects.toThrow()
  })

  test("create surfaces empty insert results as errors", async () => {
    const repo = createQuotesRepository()
    await expect(repo.create(mockDb([[]]), WS, { number: "Q-001" })).rejects.toThrow()
  })

  test("create rejects unknown status values", async () => {
    const repo = createQuotesRepository()
    await expect(
      repo.create(mockDb(), WS, { number: "Q-001", status: "approved" }),
    ).rejects.toThrow(/status/)
  })

  test("create rejects unknown discount types", async () => {
    const repo = createQuotesRepository()
    await expect(
      repo.create(mockDb(), WS, { number: "Q-001", discountType: "coupon" }),
    ).rejects.toThrow(/discountType/)
  })

  test("create rejects negative line item quantities", async () => {
    const repo = createQuotesRepository()
    await expect(
      repo.create(mockDb([[makeQuote()]]), WS, {
        number: "Q-001",
        lineItems: [{ description: "Widget", quantity: 0, unitAmountCents: 100 }],
      }),
    ).rejects.toThrow(/quantity/)
  })

  test("search returns the cursor pagination envelope", async () => {
    const repo = createQuotesRepository()
    const rows = [makeQuote({ id: "id-1" }), makeQuote({ id: "id-2" }), makeQuote({ id: "id-3" })]
    const result = await repo.search(mockDb([rows]), { workspaceId: WS, limit: 2, query: "q-0" })
    expect(result.data).toHaveLength(2)
    expect(result.pagination).toEqual({ nextCursor: "id-2", limit: 2 })
  })

  test("update returns null when the row is missing", async () => {
    const repo = createQuotesRepository()
    await expect(repo.update(mockDb([[]]), WS, "missing", { terms: "Net 30" })).resolves.toBeNull()
  })

  test("findWithLineItems returns null when the quote is missing", async () => {
    const repo = createQuotesRepository()
    await expect(repo.findWithLineItems(mockDb([[]]), WS, "missing")).resolves.toBeNull()
  })
})

describe("quotes/migration", () => {
  test("0130 creates quotes plus line items with the agreed indexes", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS quotes")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS quote_line_items")
    expect(sql).toContain("quotes_company_idx")
    expect(sql).toContain("ON quotes (company_id)")
    expect(sql).toContain("quote_line_items_product_idx")
    expect(sql).toContain("REFERENCES quotes (id) ON DELETE CASCADE")
  })

  test("cross-module references stay FK-free", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const block = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS quotes"),
      sql.indexOf("CREATE TABLE IF NOT EXISTS quote_line_items"),
    )
    expect(block).toContain("company_id UUID")
    expect(block).toContain("person_id UUID")
    expect(block).toContain("deal_id UUID")
    expect(block).not.toContain("REFERENCES companies")
    expect(block).not.toContain("REFERENCES people")
    expect(block).not.toContain("REFERENCES deals")

    const lineItemsBlock = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS quote_line_items"))
    expect(lineItemsBlock).toContain("product_id UUID")
    expect(lineItemsBlock).not.toContain("REFERENCES products")
  })
})
