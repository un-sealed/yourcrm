import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import { invoices } from "../schema/invoices"
import { quotes } from "../schema/quotes"
import {
  createPortalRepository,
  decodePortalCursor,
  encodePortalCursor,
  InvalidPortalCursorError,
  normalizePortalEmail,
  portalScopeCondition,
  toCents,
  PORTAL_VISIBLE_INVOICE_STATUSES,
  PORTAL_VISIBLE_QUOTE_STATUSES,
  type PortalReadScope,
} from "./portal-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const OTHER_WS = "99999999-9999-4999-8999-999999999999"
const PERSON_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const PERSON_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const COMPANY_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const INVOICE_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const MIGRATION = new URL("../../migrations/0330_customer_portal.sql", import.meta.url)

/**
 * Hermetic query-shape harness (`docs/conventions.md`: no live Postgres in
 * unit tests). The proxy records every builder call, so a test can pull the
 * exact `SQL` handed to `.where()` and read it.
 *
 * Reading the WHERE clause is the point. The portal's access control IS the
 * WHERE clause, so these tests assert that the scope predicate is present in
 * every customer-facing query — a post-filter in JavaScript would pass a
 * "does it return the right rows" test against a fake store while leaking in
 * production the moment someone paginates.
 */
function mockDb(queued: unknown[][] = []) {
  const calls: { method: string; args: unknown[] }[] = []
  let step = 0
  const proxy = new Proxy(function () {}, {
    get(_target, prop: string | symbol) {
      if (prop === "then") {
        return (resolve: (value: unknown) => void) => {
          resolve(queued[step] ?? [])
          step += 1
        }
      }
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), args })
        return proxy
      }
    },
  })
  return { db: proxy as unknown as Database, calls }
}

/**
 * Flatten a drizzle `SQL` node into inspectable text: literal SQL as-is,
 * columns as their column names, bound parameters as `?`. Values render as
 * `?` on purpose — these assertions check the SHAPE of the predicate, so a
 * filter that stopped reaching the WHERE clause cannot pass by accident.
 */
function render(node: unknown): string {
  const out: string[] = []
  const walk = (chunk: unknown): void => {
    if (chunk === null || chunk === undefined) return
    if (Array.isArray(chunk)) {
      for (const inner of chunk) walk(inner)
      return
    }
    if (typeof chunk === "object") {
      const record = chunk as Record<string, unknown>
      if (Array.isArray(record.value)) {
        for (const inner of record.value) out.push(String(inner))
        return
      }
      if (typeof record.name === "string" && "keyAsName" in record) {
        out.push(record.name)
        return
      }
      if (Array.isArray(record.queryChunks)) {
        for (const inner of record.queryChunks) walk(inner)
        return
      }
    }
    out.push("?")
  }
  walk(node)
  return out.join("").replace(/\s+/g, " ").trim()
}

function whereOf(calls: { method: string; args: unknown[] }[], index = 0): string {
  const wheres = calls.filter((call) => call.method === "where")
  return render(wheres[index]?.args[0])
}

function selectedKeys(calls: { method: string; args: unknown[] }[]): string[] {
  const select = calls.find((call) => call.method === "select")
  const shape = select?.args[0]
  return shape && typeof shape === "object" ? Object.keys(shape) : []
}

function scope(overrides: Partial<PortalReadScope> = {}): PortalReadScope {
  return { workspaceId: WS, personIds: [PERSON_A], companyIds: [COMPANY_A], ...overrides }
}

const repo = createPortalRepository()

describe("database/portal-repository: scope containment", () => {
  test("the scope predicate names workspace, soft delete and both owner columns", () => {
    const sql = render(
      portalScopeCondition(
        {
          workspaceId: invoices.workspaceId,
          deletedAt: invoices.deletedAt,
          personId: invoices.personId,
          companyId: invoices.companyId,
        },
        scope(),
      ),
    )
    expect(sql).toContain("workspace_id = ?")
    expect(sql).toContain("deleted_at is null")
    expect(sql).toContain("person_id in")
    expect(sql).toContain("company_id in")

    // The same predicate, built over the quotes table's own columns.
    const quoteSql = render(
      portalScopeCondition(
        {
          workspaceId: quotes.workspaceId,
          deletedAt: quotes.deletedAt,
          personId: quotes.personId,
          companyId: quotes.companyId,
        },
        scope(),
      ),
    )
    expect(quoteSql).toBe(sql)
  })

  test("an empty scope compiles to false, never to an unfiltered query", () => {
    const sql = render(
      portalScopeCondition(
        {
          workspaceId: invoices.workspaceId,
          deletedAt: invoices.deletedAt,
          personId: invoices.personId,
          companyId: invoices.companyId,
        },
        { workspaceId: WS, personIds: [], companyIds: [] },
      ),
    )
    expect(sql).toContain("false or false")
    expect(sql).not.toContain("person_id in")
  })

  test("invoice list filters by scope AND the portal-visible status list", async () => {
    const { db, calls } = mockDb([[]])
    await repo.listInvoices(db, scope())
    const sql = whereOf(calls)
    expect(sql).toContain("workspace_id = ?")
    expect(sql).toContain("deleted_at is null")
    expect(sql).toContain("person_id in")
    expect(sql).toContain("company_id in")
    expect(sql).toContain("status in")
    expect(PORTAL_VISIBLE_INVOICE_STATUSES).not.toContain("draft")
  })

  test("invoice detail scopes by id AND scope — never by id alone", async () => {
    const { db, calls } = mockDb([[]])
    await repo.findInvoice(db, scope(), INVOICE_B)
    const sql = whereOf(calls)
    expect(sql).toContain("id = ?")
    expect(sql).toContain("workspace_id = ?")
    expect(sql).toContain("person_id in")
  })

  test("an identity with no grants gets a false predicate on the detail read", async () => {
    const { db, calls } = mockDb([[]])
    const found = await repo.findInvoice(
      db,
      { workspaceId: WS, personIds: [], companyIds: [] },
      INVOICE_B,
    )
    expect(found).toBeNull()
    expect(whereOf(calls)).toContain("false or false")
  })

  test("line items re-scope through their parent invoice, not by invoice id", async () => {
    const { db, calls } = mockDb([[]])
    await repo.listInvoiceLineItems(db, scope(), INVOICE_B)
    const join = calls.find((call) => call.method === "innerJoin")
    expect(join).toBeDefined()
    const sql = whereOf(calls)
    expect(sql).toContain("invoice_id = ?")
    expect(sql).toContain("workspace_id = ?")
    expect(sql).toContain("person_id in")
  })

  test("the payments aggregate is scoped too", async () => {
    const { db, calls } = mockDb([[{ total: "500" }]])
    const paid = await repo.sumInvoicePayments(db, scope(), INVOICE_B)
    expect(paid).toBe(500)
    expect(whereOf(calls)).toContain("person_id in")
  })

  test("quote list and detail carry the same scope", async () => {
    const list = mockDb([[]])
    await repo.listQuotes(list.db, scope())
    expect(whereOf(list.calls)).toContain("person_id in")
    expect(whereOf(list.calls)).toContain("status in")
    expect(PORTAL_VISIBLE_QUOTE_STATUSES).not.toContain("draft")

    const detail = mockDb([[]])
    await repo.findQuote(detail.db, scope(), INVOICE_B)
    expect(whereOf(detail.calls)).toContain("id = ?")
    expect(whereOf(detail.calls)).toContain("company_id in")

    const items = mockDb([[]])
    await repo.listQuoteLineItems(items.db, scope(), INVOICE_B)
    expect(whereOf(items.calls)).toContain("person_id in")
  })

  test("a caller-supplied status filter narrows the allow-list, never widens it", async () => {
    const { db, calls } = mockDb([[]])
    await repo.listInvoices(db, scope(), { status: "paid" })
    const sql = whereOf(calls)
    // Both predicates survive: `status IN (visible) AND status = 'paid'`.
    expect(sql).toContain("status in")
    expect(sql).toContain("status = ?")
  })

  test("a foreign workspace id in the scope is simply the workspace filter", async () => {
    const { db, calls } = mockDb([[]])
    await repo.listInvoices(db, scope({ workspaceId: OTHER_WS }))
    expect(whereOf(calls)).toContain("workspace_id = ?")
  })
})

describe("database/portal-repository: projection", () => {
  test("invoice reads select an allow-list with no internal columns", async () => {
    const { db, calls } = mockDb([[]])
    await repo.listInvoices(db, scope())
    const keys = selectedKeys(calls)
    expect(keys).toContain("number")
    expect(keys).toContain("totalCents")
    for (const forbidden of [
      "notes",
      "ownerId",
      "personId",
      "companyId",
      "createdBy",
      "updatedBy",
    ]) {
      expect(keys).not.toContain(forbidden)
    }
  })

  test("quote reads keep customer-facing terms but drop internal notes", async () => {
    const { db, calls } = mockDb([[]])
    await repo.listQuotes(db, scope())
    const keys = selectedKeys(calls)
    expect(keys).toContain("terms")
    for (const forbidden of ["notes", "ownerId", "dealId", "personId", "companyId"]) {
      expect(keys).not.toContain(forbidden)
    }
  })

  test("the money aggregates correlate on a table-qualified column", async () => {
    // Regression: drizzle renders a column placed in a SELECT list
    // unqualified, so interpolating `invoices.id` into these subqueries
    // produced `li.invoice_id = "id"` — which binds to the subquery's own
    // table, matches nothing and reports every invoice as worth zero.
    const invoiceCalls = mockDb([[]])
    await repo.listInvoices(invoiceCalls.db, scope())
    const invoiceSelect = invoiceCalls.calls.find((call) => call.method === "select")
      ?.args[0] as Record<string, unknown>
    expect(render(invoiceSelect.totalCents)).toContain('"invoices"."id"')
    expect(render(invoiceSelect.paidCents)).toContain('"invoices"."id"')

    const quoteCalls = mockDb([[]])
    await repo.listQuotes(quoteCalls.db, scope())
    const quoteSelect = quoteCalls.calls.find((call) => call.method === "select")
      ?.args[0] as Record<string, unknown>
    expect(render(quoteSelect.subtotalCents)).toContain('"quotes"."id"')
  })

  test("bigint aggregates are coerced to numbers", () => {
    expect(toCents("1200")).toBe(1200)
    expect(toCents(1200)).toBe(1200)
    expect(toCents(null)).toBe(0)
    expect(toCents("not-a-number")).toBe(0)
  })
})

describe("database/portal-repository: tokens and sessions", () => {
  test("consuming a magic link is one atomic guarded UPDATE", async () => {
    const { db, calls } = mockDb([[]])
    await repo.consumeMagicLink(db, "hash")
    expect(calls.some((call) => call.method === "update")).toBe(true)
    expect(calls.some((call) => call.method === "returning")).toBe(true)
    const sql = whereOf(calls)
    expect(sql).toContain("token_hash = ?")
    expect(sql).toContain("kind = ?")
    expect(sql).toContain("consumed_at is null")
    expect(sql).toContain("revoked_at is null")
    expect(sql).toContain("expires_at > ?")
  })

  test("a magic-link hash cannot resolve as a session", async () => {
    const { db, calls } = mockDb([[]])
    await repo.findActiveSession(db, "hash")
    const sql = whereOf(calls)
    expect(sql).toContain("kind = ?")
    expect(sql).toContain("revoked_at is null")
    expect(sql).toContain("expires_at > ?")
  })

  test("identity lookup by email only matches live, unrevoked, unexpired rows", async () => {
    const { db, calls } = mockDb([[]])
    await repo.findActiveIdentitiesByEmail(db, "  Ada@Example.COM ")
    const sql = whereOf(calls)
    expect(sql).toContain("email = ?")
    expect(sql).toContain("deleted_at is null")
    expect(sql).toContain("revoked_at is null")
    expect(sql).toContain("status = ?")
    expect(sql).toContain("expires_at is null or")
  })

  test("revoking an identity also revokes its live sessions", async () => {
    const { db, calls } = mockDb([[], []])
    await repo.revokeIdentity(db, WS, PERSON_B)
    expect(calls.filter((call) => call.method === "update").length).toBe(2)
    expect(whereOf(calls, 1)).toContain("portal_identity_id = ?")
  })

  test("emails normalise before they are stored or compared", () => {
    expect(normalizePortalEmail("  Ada@Example.COM ")).toBe("ada@example.com")
  })
})

describe("database/portal-repository: cursors", () => {
  test("cursors round-trip", () => {
    const at = new Date("2026-05-01T12:00:00.000Z")
    const decoded = decodePortalCursor(encodePortalCursor(at, PERSON_A))
    expect(decoded?.createdAt.toISOString()).toBe(at.toISOString())
    expect(decoded?.id).toBe(PERSON_A)
  })

  test("absent cursors are null and malformed cursors throw", () => {
    expect(decodePortalCursor(undefined)).toBeNull()
    expect(decodePortalCursor("")).toBeNull()
    expect(() => decodePortalCursor("!!!not base64!!!")).toThrow(InvalidPortalCursorError)
    expect(() => decodePortalCursor(btoa("2026-05-01T12:00:00Z|not-a-uuid"))).toThrow(
      InvalidPortalCursorError,
    )
  })

  test("a cursor adds a keyset predicate, still inside the scope", async () => {
    const { db, calls } = mockDb([[]])
    await repo.listInvoices(db, scope(), {
      cursor: encodePortalCursor(new Date("2026-05-01T12:00:00Z"), PERSON_A),
    })
    const sql = whereOf(calls)
    expect(sql).toContain("person_id in")
    expect(sql).toContain("created_at <")
  })
})

describe("database/portal-repository: migration 0330", () => {
  test("creates exactly the three portal tables", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS portal_identities")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS portal_access_grants")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS portal_sessions")
  })

  test("foreign keys point only at workspaces and at portal tables", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const references = [...sql.matchAll(/REFERENCES\s+(\w+)/g)]
      .map((match) => match[1])
      .filter((target): target is string => target !== undefined)
    expect(references.length).toBeGreaterThan(0)
    for (const target of references) {
      expect(["workspaces", "portal_identities"]).toContain(target)
    }
    // person_id and scope_id stay plain uuids: other modules own those tables.
    expect(sql).not.toContain("REFERENCES people")
    expect(sql).not.toContain("REFERENCES companies")
    expect(sql).not.toContain("REFERENCES tickets")
    expect(sql).not.toContain("REFERENCES invoices")
  })

  test("token hashes are globally unique and the single-use guard is enforceable", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("portal_sessions_token_hash_uidx")
    expect(sql).toContain("consumed_at")
    expect(sql).toContain("portal_sessions_kind_chk")
  })

  test("the migration never creates a membership or a user for a portal identity", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).not.toContain("INSERT INTO memberships")
    expect(sql).not.toContain("INSERT INTO users")
  })
})
