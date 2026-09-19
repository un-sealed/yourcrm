import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import { people, personEmails, personPhones, type Person } from "../schema/people"
import {
  createPeopleRepository,
  normalizePersonName,
  validatePersonEmail,
  validatePersonPhone,
} from "./people-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const PERSON_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const MIGRATION = new URL("../../migrations/0010_people.sql", import.meta.url)

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

function makePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: PERSON_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    ownerId: null,
    firstName: "Ada",
    lastName: "Lovelace",
    title: "Engineer",
    companyId: null,
    status: "active",
    preferredChannel: "email",
    notes: null,
    ...overrides,
  }
}

describe("people/schema", () => {
  test("people expose the BaseRecord column contract", () => {
    const cols = people as unknown as Record<string, unknown>
    for (const col of ["id", "workspaceId", "createdAt", "updatedAt", "deletedAt"]) {
      expect(cols[col], col).toBeDefined()
    }
    expect(cols.firstName).toBeDefined()
    expect(cols.companyId).toBeDefined()
    expect(cols.ownerId).toBeDefined()
  })

  test("contact tables carry a person FK plus workspace scoping", () => {
    for (const table of [personEmails, personPhones]) {
      const cols = table as unknown as Record<string, unknown>
      expect(cols.personId).toBeDefined()
      expect(cols.workspaceId).toBeDefined()
      expect(cols.isPrimary).toBeDefined()
    }
  })
})

describe("people/validation", () => {
  test("names trim and collapse whitespace", () => {
    expect(normalizePersonName("  Ada   Lovelace ", "firstName")).toBe("Ada Lovelace")
  })

  test("names reject empty and overlong values", () => {
    expect(() => normalizePersonName("   ", "firstName")).toThrow()
    expect(() => normalizePersonName("x".repeat(256), "firstName")).toThrow()
  })

  test("emails lowercase and validate shape", () => {
    expect(validatePersonEmail("Ada@Example.COM ")).toBe("ada@example.com")
    expect(() => validatePersonEmail("not-an-email")).toThrow()
  })

  test("phones reject empty and overlong values", () => {
    expect(validatePersonPhone(" +1 555 0100 ")).toBe("+1 555 0100")
    expect(() => validatePersonPhone("   ")).toThrow()
  })
})

describe("people/repository", () => {
  test("create returns the inserted row", async () => {
    const repo = createPeopleRepository()
    const row = makePerson()
    const result = await repo.create(mockDb([[row]]), WS, { firstName: "Ada" })
    expect(result).toBe(row)
  })

  test("create rejects empty names before touching the db", async () => {
    const repo = createPeopleRepository()
    await expect(repo.create(mockDb(), WS, { firstName: "  " })).rejects.toThrow()
  })

  test("create surfaces empty insert results as errors", async () => {
    const repo = createPeopleRepository()
    await expect(repo.create(mockDb([[]]), WS, { firstName: "Ada" })).rejects.toThrow()
  })

  test("create rejects unknown status values", async () => {
    const repo = createPeopleRepository()
    await expect(repo.create(mockDb(), WS, { firstName: "Ada", status: "vip" })).rejects.toThrow(
      /status/,
    )
  })

  test("search returns the cursor pagination envelope", async () => {
    const repo = createPeopleRepository()
    const rows = [
      makePerson({ id: "id-1" }),
      makePerson({ id: "id-2" }),
      makePerson({ id: "id-3" }),
    ]
    const result = await repo.search(mockDb([rows]), { workspaceId: WS, limit: 2, query: "ada" })
    expect(result.data).toHaveLength(2)
    expect(result.pagination).toEqual({ nextCursor: "id-2", limit: 2 })
  })

  test("update returns null when the row is missing", async () => {
    const repo = createPeopleRepository()
    await expect(repo.update(mockDb([[]]), WS, "missing", { title: "CTO" })).resolves.toBeNull()
  })

  test("findWithContacts returns null when the person is missing", async () => {
    const repo = createPeopleRepository()
    await expect(repo.findWithContacts(mockDb([[]]), WS, "missing")).resolves.toBeNull()
  })
})

describe("people/migration", () => {
  test("0010 creates people plus contact tables with the agreed indexes", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS people")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS person_emails")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS person_phones")
    expect(sql).toContain("people_company_idx")
    expect(sql).toContain("ON people (company_id)")
    expect(sql).toContain("person_emails_person_email_uidx")
    expect(sql).toContain("person_phones_person_phone_uidx")
    expect(sql).toContain("REFERENCES people (id) ON DELETE CASCADE")
  })

  test("company references stay FK-free", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const block = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS people"),
      sql.indexOf("CREATE TABLE IF NOT EXISTS person_emails"),
    )
    expect(block).toContain("company_id UUID")
    expect(block).not.toContain("REFERENCES companies")
  })
})
