import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import {
  isSalesSequenceEnrollmentRunnable,
  isSalesSequenceEnrollmentStatus,
  isSalesSequenceExitReason,
  isSalesSequenceStatus,
  isSalesSequenceStepType,
  salesSequenceStepDelayMs,
  SALES_SEQUENCE_ENROLLMENT_STATUSES,
  SALES_SEQUENCE_EXIT_REASONS,
  SALES_SEQUENCE_STATUSES,
  SALES_SEQUENCE_STEP_TYPES,
  SALES_SEQUENCE_SUPPRESSING_EXIT_REASONS,
} from "../schema/sequences"
import {
  createSalesSequencesRepository,
  normalizeSalesSequenceEmail,
  normalizeSalesSequenceName,
  SalesSequenceDefinitionError,
  validateSalesSequenceEnrollmentStatus,
  validateSalesSequenceExitReason,
  validateSalesSequenceStatus,
} from "./sequences-repository"

const MIGRATION = new URL("../../migrations/0270_sales_engagement.sql", import.meta.url)

/**
 * Hermetic repository tests: pure validation helpers plus assertions on
 * migration 0270 itself. `docs/conventions.md` forbids a live Postgres
 * here, and the two UNIQUE indexes are load-bearing enough that their
 * presence deserves a test rather than a comment — if one is dropped, the
 * send-once guarantee silently becomes a send-often guarantee.
 */

describe("sequences-repository/validation", () => {
  test("names are trimmed, collapsed and bounded", () => {
    expect(normalizeSalesSequenceName("  Outbound   v1 ")).toBe("Outbound v1")
    expect(() => normalizeSalesSequenceName("   ")).toThrow(SalesSequenceDefinitionError)
    expect(() => normalizeSalesSequenceName("x".repeat(256))).toThrow(SalesSequenceDefinitionError)
  })

  test("recipient addresses are lowercased and must look like addresses", () => {
    expect(normalizeSalesSequenceEmail("  Ada@Example.COM ")).toBe("ada@example.com")
    expect(() => normalizeSalesSequenceEmail("nope")).toThrow(SalesSequenceDefinitionError)
    expect(() => normalizeSalesSequenceEmail("")).toThrow(SalesSequenceDefinitionError)
  })

  test("statuses, step types and exit reasons come from allowlists", () => {
    for (const status of SALES_SEQUENCE_STATUSES) {
      expect(validateSalesSequenceStatus(status)).toBe(status)
      expect(isSalesSequenceStatus(status)).toBe(true)
    }
    expect(() => validateSalesSequenceStatus("exploded")).toThrow(SalesSequenceDefinitionError)

    for (const status of SALES_SEQUENCE_ENROLLMENT_STATUSES) {
      expect(validateSalesSequenceEnrollmentStatus(status)).toBe(status)
      expect(isSalesSequenceEnrollmentStatus(status)).toBe(true)
    }
    expect(() => validateSalesSequenceEnrollmentStatus("sending")).toThrow(
      SalesSequenceDefinitionError,
    )

    for (const reason of SALES_SEQUENCE_EXIT_REASONS) {
      expect(validateSalesSequenceExitReason(reason)).toBe(reason)
      expect(isSalesSequenceExitReason(reason)).toBe(true)
    }
    expect(validateSalesSequenceExitReason(null)).toBeNull()
    expect(() => validateSalesSequenceExitReason("bored")).toThrow(SalesSequenceDefinitionError)

    expect(SALES_SEQUENCE_STEP_TYPES).toEqual(["email", "task", "wait"])
    expect(isSalesSequenceStepType("sms")).toBe(false)
  })

  /**
   * Only `active` runs. This single predicate is what every queued step
   * consults, so "replied", "paused", "completed" and "stopped" all have
   * to be false or a stopped drip would resume.
   */
  test("only an active enrollment is runnable", () => {
    expect(isSalesSequenceEnrollmentRunnable("active")).toBe(true)
    for (const status of SALES_SEQUENCE_ENROLLMENT_STATUSES.filter((s) => s !== "active")) {
      expect(isSalesSequenceEnrollmentRunnable(status)).toBe(false)
    }
    expect(isSalesSequenceEnrollmentRunnable(undefined)).toBe(false)
  })

  test("unsubscribes and bounces suppress the contact workspace-wide", () => {
    expect([...SALES_SEQUENCE_SUPPRESSING_EXIT_REASONS]).toEqual(["unsubscribed", "bounced"])
    // A reply must NOT suppress: replying is engagement, not an opt-out.
    expect([...SALES_SEQUENCE_SUPPRESSING_EXIT_REASONS]).not.toContain("replied")
  })

  test("step delay converts days and hours to milliseconds", () => {
    expect(salesSequenceStepDelayMs({ waitDays: 0, waitHours: 0 })).toBe(0)
    expect(salesSequenceStepDelayMs({ waitDays: 1, waitHours: 2 })).toBe(26 * 60 * 60 * 1000)
    expect(salesSequenceStepDelayMs({ waitDays: null, waitHours: null })).toBe(0)
    expect(salesSequenceStepDelayMs({ waitDays: -5, waitHours: 0 })).toBe(0)
  })

  test("the repository factory is pure (no connection at construction)", () => {
    expect(() => createSalesSequencesRepository()).not.toThrow()
  })
})

describe("sequences-repository/migration-0270", () => {
  test("the send-once and enrol-once unique indexes exist", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    // THE idempotency key: one attempt per (enrollment, step).
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS sequence_step_runs_step_uidx")
    expect(sql).toMatch(
      /sequence_step_runs_step_uidx\s*\n?\s*ON sequence_step_runs \(enrollment_id, step_index\)/,
    )
    // One enrollment per (sequence, person): enrolment is idempotent too.
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS sequence_enrollments_person_uidx")
    expect(sql).toMatch(
      /sequence_enrollments_person_uidx\s*\n?\s*ON sequence_enrollments \(sequence_id, person_id\)/,
    )
    // Step order is a set, not a bag.
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS sequence_steps_position_uidx")
  })

  test("every status and exit reason is constrained in SQL as well as in code", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    for (const status of SALES_SEQUENCE_STATUSES) expect(sql).toContain(`'${status}'`)
    for (const status of SALES_SEQUENCE_ENROLLMENT_STATUSES) expect(sql).toContain(`'${status}'`)
    for (const reason of SALES_SEQUENCE_EXIT_REASONS) expect(sql).toContain(`'${reason}'`)
    for (const type of SALES_SEQUENCE_STEP_TYPES) expect(sql).toContain(`'${type}'`)
    expect(sql).toContain("sequence_enrollments_status_chk")
    expect(sql).toContain("sequence_enrollments_exit_reason_chk")
    expect(sql).toContain("sequence_steps_type_chk")
  })

  test("a wait step cannot be a zero-length wait", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("sequence_steps_wait_nonzero_chk")
  })

  /**
   * FK policy: foreign keys only between the four tables this migration
   * owns. person_id, deal_id and thread_id belong to other modules and
   * must stay plain uuid columns.
   */
  test("no foreign keys reach into another module's tables", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const references = [...sql.matchAll(/REFERENCES\s+([a-z_]+)\s*\(/g)].map((m) => m[1])
    expect(new Set(references)).toEqual(
      new Set(["sequences", "sequence_enrollments", "sequence_steps"]),
    )
    expect(sql).not.toMatch(/person_id\s+UUID\s+NOT NULL\s+REFERENCES/)
    expect(sql).not.toMatch(/thread_id\s+UUID\s+REFERENCES/)
    expect(sql).not.toMatch(/deal_id\s+UUID\s+REFERENCES/)
  })

  test("the exit lookups the engine depends on are indexed", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("sequence_enrollments_thread_idx")
    expect(sql).toContain("sequence_enrollments_person_idx")
    expect(sql).toContain("sequence_enrollments_email_idx")
    expect(sql).toContain("sequence_enrollments_due_idx")
  })
})
