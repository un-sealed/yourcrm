import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  isSalesSequenceEnrollmentStatus,
  isSalesSequenceExitReason,
  isSalesSequenceStatus,
  isSalesSequenceStepRunStatus,
  isSalesSequenceStepType,
  salesSequenceEnrollments,
  salesSequences,
  salesSequenceStepRuns,
  salesSequenceSteps,
  SALES_SEQUENCE_MAX_STEPS,
  SALES_SEQUENCE_MAX_WAIT_DAYS,
  SALES_SEQUENCE_MAX_WAIT_HOURS,
  SALES_SEQUENCE_SUPPRESSING_EXIT_REASONS,
  type NewSalesSequence,
  type SalesSequence,
  type SalesSequenceEnrollment,
  type SalesSequenceStep,
  type SalesSequenceStepConfig,
  type SalesSequenceStepRun,
} from "../schema/sequences"
import { createBaseRepository } from "./base-repository"

/**
 * Sales sequences repository (spec 47-sales-engagement, P0).
 *
 * Four tables, one file, because they share a transaction boundary in
 * practice: definitions (`sequences`), their ordered steps
 * (`sequence_steps`), enrollments (`sequence_enrollments`) and per-step
 * attempts (`sequence_step_runs`).
 *
 * THE TWO IDEMPOTENT WRITES
 * -------------------------
 * `enrollPerson` and `claimStepRun` both insert with `ON CONFLICT DO
 * NOTHING` against a UNIQUE index and, on conflict, select the existing
 * row and report `created: false` / `claimed: false`. That is the entire
 * idempotency mechanism: it lives in Postgres, so two workers racing on a
 * redelivered job still produce one enrollment and one send per step. The
 * automation repository (0190) does exactly this; there is one execution
 * model in this product, not two.
 *
 * Everything user-supplied is validated here before it reaches SQL —
 * statuses, step types and exit reasons against the schema allowlists,
 * names and JSON shapes structurally. Values are always bound by drizzle,
 * never interpolated.
 */

export class SalesSequenceDefinitionError extends Error {
  readonly code = "INVALID_SEQUENCE"
  constructor(message: string) {
    super(message)
    this.name = "SalesSequenceDefinitionError"
  }
}

/* ------------------------------ validation -------------------------------- */

/** Trimmed, non-empty sequence name (max 255, mirrors the column). */
export function normalizeSalesSequenceName(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) {
    throw new SalesSequenceDefinitionError("sequence name must not be empty")
  }
  if (trimmed.length > 255) {
    throw new SalesSequenceDefinitionError("sequence name must be at most 255 characters")
  }
  return trimmed
}

/** Lowercased, trimmed recipient address (max 320, mirrors the column). */
export function normalizeSalesSequenceEmail(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (trimmed.length === 0 || !trimmed.includes("@")) {
    throw new SalesSequenceDefinitionError("an enrollment needs a valid email address")
  }
  if (trimmed.length > 320) {
    throw new SalesSequenceDefinitionError("email address must be at most 320 characters")
  }
  return trimmed
}

export function validateSalesSequenceStatus(value: unknown): string {
  if (!isSalesSequenceStatus(value)) {
    throw new SalesSequenceDefinitionError(
      "status must be one of draft, active, paused or archived",
    )
  }
  return value
}

export function validateSalesSequenceEnrollmentStatus(value: unknown): string {
  if (!isSalesSequenceEnrollmentStatus(value)) {
    throw new SalesSequenceDefinitionError(`unknown enrollment status '${String(value)}'`)
  }
  return value
}

export function validateSalesSequenceExitReason(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (!isSalesSequenceExitReason(value)) {
    throw new SalesSequenceDefinitionError(`unknown exit reason '${String(value)}'`)
  }
  return value
}

function validateWait(field: string, value: number, max: number): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new SalesSequenceDefinitionError(`${field} must be a whole number between 0 and ${max}`)
  }
  return value
}

/* --------------------------------- inputs --------------------------------- */

export type CreateSalesSequenceInput = {
  name: string
  description?: string | null
  status?: string | null
  ownerId?: string | null
  exitOnReply?: boolean | null
  exitOnBounce?: boolean | null
}

export type UpdateSalesSequenceInput = Partial<CreateSalesSequenceInput>

export type SalesSequenceSearchOptions = {
  workspaceId: string
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  status?: string
  ownerId?: string
}

/** One step as the editor saves it. `stepIndex` is assigned by position. */
export type SalesSequenceStepInput = {
  stepType: string
  name?: string | null
  waitDays?: number | null
  waitHours?: number | null
  config?: SalesSequenceStepConfig | null
}

export type EnrollPersonInput = {
  sequenceId: string
  personId: string
  dealId?: string | null
  emailAddress: string
  enrolledBy?: string | null
  nextRunAt?: Date | null
}

export type UpdateSalesSequenceEnrollmentInput = Partial<{
  status: string
  exitReason: string | null
  currentStepIndex: number
  nextRunAt: Date | null
  threadId: string | null
  actorRole: string | null
  startedAt: Date | null
  lastStepAt: Date | null
  completedAt: Date | null
  stoppedAt: Date | null
  error: string | null
}>

export type SalesSequenceEnrollmentSearchOptions = {
  workspaceId: string
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  sequenceId?: string
  personId?: string
  status?: string
  exitReason?: string
}

export type ClaimSalesSequenceStepRunInput = {
  enrollmentId: string
  stepIndex: number
  stepType: string
  stepId?: string | null
  actorId?: string | null
  actorRole?: string | null
}

export type CompleteSalesSequenceStepRunInput = Partial<{
  status: string
  result: unknown
  error: string | null
}>

function toSequenceValues(
  input: CreateSalesSequenceInput | UpdateSalesSequenceInput,
  actorId?: string,
): Partial<NewSalesSequence> {
  const values: Partial<NewSalesSequence> = {}
  if (input.name !== undefined) values.name = normalizeSalesSequenceName(input.name)
  if (input.description !== undefined) values.description = input.description?.trim() || null
  if (input.status !== undefined && input.status !== null) {
    values.status = validateSalesSequenceStatus(input.status)
  }
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (input.exitOnReply !== undefined && input.exitOnReply !== null) {
    values.exitOnReply = input.exitOnReply
  }
  if (input.exitOnBounce !== undefined && input.exitOnBounce !== null) {
    values.exitOnBounce = input.exitOnBounce
  }
  if (actorId !== undefined) values.updatedBy = actorId
  return values
}

/* ------------------------------- repository ------------------------------- */

export function createSalesSequencesRepository() {
  const base = createBaseRepository(salesSequences)

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateSalesSequenceInput,
      actorId?: string,
    ): Promise<SalesSequence> {
      const rows = await db
        .insert(salesSequences)
        .values({
          ...toSequenceValues(input, actorId),
          workspaceId,
          name: normalizeSalesSequenceName(input.name),
          // A sequence sends nothing until somebody activates it.
          status: input.status == null ? "draft" : validateSalesSequenceStatus(input.status),
          ownerId: input.ownerId ?? actorId ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new SalesSequenceDefinitionError("sequences.create: insert returned no rows")
      return row
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateSalesSequenceInput,
      actorId?: string,
    ): Promise<SalesSequence | null> {
      const rows = await db
        .update(salesSequences)
        .set({ ...toSequenceValues(input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(salesSequences.id, id),
            eq(salesSequences.workspaceId, workspaceId),
            isNull(salesSequences.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<SalesSequence | null> {
      // The shared base narrows rows to the BaseRecord columns; re-cast so
      // callers get the full SalesSequence shape.
      return ((await base.findById(db, workspaceId, id)) as SalesSequence | null) ?? null
    },

    /** Cursor-paginated definition list with search + status/owner filters. */
    async search(db: Database, opts: SalesSequenceSearchOptions) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const match = or(ilike(salesSequences.name, q), ilike(salesSequences.description, q))
        if (match) conditions.push(match)
      }
      if (opts.status) {
        conditions.push(eq(salesSequences.status, validateSalesSequenceStatus(opts.status)))
      }
      if (opts.ownerId) conditions.push(eq(salesSequences.ownerId, opts.ownerId))
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as SalesSequence[], pagination: result.pagination }
    },

    async markEnrolled(
      db: Database,
      workspaceId: string,
      id: string,
      at: Date = new Date(),
    ): Promise<void> {
      await db
        .update(salesSequences)
        .set({ lastEnrolledAt: at })
        .where(and(eq(salesSequences.id, id), eq(salesSequences.workspaceId, workspaceId)))
    },

    /* --------------------------------- steps -------------------------------- */

    async listSteps(
      db: Database,
      workspaceId: string,
      sequenceId: string,
    ): Promise<SalesSequenceStep[]> {
      return db
        .select()
        .from(salesSequenceSteps)
        .where(
          and(
            eq(salesSequenceSteps.workspaceId, workspaceId),
            eq(salesSequenceSteps.sequenceId, sequenceId),
            isNull(salesSequenceSteps.deletedAt),
          ),
        )
        .orderBy(asc(salesSequenceSteps.stepIndex))
    },

    /**
     * Replace the whole ordered step list. The editor saves a list, not a
     * diff, so re-deriving `step_index` from array position is the only way
     * the stored order can never disagree with what the user saw.
     *
     * Deleting a step a running enrollment has already executed is safe:
     * `sequence_step_runs.step_id` is ON DELETE SET NULL and the run keeps
     * its own `step_index` / `step_type` copy, so history survives.
     */
    async replaceSteps(
      db: Database,
      workspaceId: string,
      sequenceId: string,
      steps: SalesSequenceStepInput[],
      actorId?: string,
    ): Promise<SalesSequenceStep[]> {
      if (steps.length > SALES_SEQUENCE_MAX_STEPS) {
        throw new SalesSequenceDefinitionError(
          `a sequence may have at most ${SALES_SEQUENCE_MAX_STEPS} steps`,
        )
      }
      const values = steps.map((step, index) => {
        if (!isSalesSequenceStepType(step.stepType)) {
          throw new SalesSequenceDefinitionError(
            `step ${index} has unknown type '${String(step.stepType)}' (email, task, wait)`,
          )
        }
        const waitDays = validateWait("waitDays", step.waitDays ?? 0, SALES_SEQUENCE_MAX_WAIT_DAYS)
        const waitHours = validateWait(
          "waitHours",
          step.waitHours ?? 0,
          SALES_SEQUENCE_MAX_WAIT_HOURS,
        )
        if (step.stepType === "wait" && waitDays === 0 && waitHours === 0) {
          throw new SalesSequenceDefinitionError(`step ${index}: a wait step needs a delay`)
        }
        return {
          workspaceId,
          sequenceId,
          stepIndex: index,
          stepType: step.stepType,
          name: step.name?.trim() || null,
          waitDays,
          waitHours,
          config: step.config ?? {},
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        }
      })

      return db.transaction(async (tx) => {
        await tx
          .delete(salesSequenceSteps)
          .where(
            and(
              eq(salesSequenceSteps.workspaceId, workspaceId),
              eq(salesSequenceSteps.sequenceId, sequenceId),
            ),
          )
        if (values.length === 0) return []
        return tx.insert(salesSequenceSteps).values(values).returning()
      })
    },

    /* ------------------------------ enrollments ----------------------------- */

    /**
     * IDEMPOTENT enrolment. `sequence_enrollments_person_uidx` is UNIQUE
     * over (sequence_id, person_id), so enrolling somebody twice conflicts
     * and the existing enrollment comes back with `created: false` — no
     * parallel drip, and a double-clicked button is harmless.
     */
    async enrollPerson(
      db: Database,
      workspaceId: string,
      input: EnrollPersonInput,
    ): Promise<{ enrollment: SalesSequenceEnrollment; created: boolean }> {
      const inserted = await db
        .insert(salesSequenceEnrollments)
        .values({
          workspaceId,
          sequenceId: input.sequenceId,
          personId: input.personId,
          dealId: input.dealId ?? null,
          emailAddress: normalizeSalesSequenceEmail(input.emailAddress),
          status: "active",
          currentStepIndex: 0,
          nextRunAt: input.nextRunAt ?? new Date(),
          startedAt: new Date(),
          enrolledBy: input.enrolledBy ?? null,
          ...(input.enrolledBy == null
            ? {}
            : { createdBy: input.enrolledBy, updatedBy: input.enrolledBy }),
        })
        .onConflictDoNothing({
          target: [salesSequenceEnrollments.sequenceId, salesSequenceEnrollments.personId],
        })
        .returning()
      const created = inserted[0]
      if (created) return { enrollment: created, created: true }

      const existing = await db
        .select()
        .from(salesSequenceEnrollments)
        .where(
          and(
            eq(salesSequenceEnrollments.workspaceId, workspaceId),
            eq(salesSequenceEnrollments.sequenceId, input.sequenceId),
            eq(salesSequenceEnrollments.personId, input.personId),
          ),
        )
        .limit(1)
      const row = existing[0]
      if (!row) {
        throw new SalesSequenceDefinitionError("sequence_enrollments: conflict without a row")
      }
      return { enrollment: row, created: false }
    },

    async findEnrollmentById(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<SalesSequenceEnrollment | null> {
      const rows = await db
        .select()
        .from(salesSequenceEnrollments)
        .where(
          and(
            eq(salesSequenceEnrollments.id, id),
            eq(salesSequenceEnrollments.workspaceId, workspaceId),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    async searchEnrollments(db: Database, opts: SalesSequenceEnrollmentSearchOptions) {
      const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200)
      const conditions: SQL[] = [
        eq(salesSequenceEnrollments.workspaceId, opts.workspaceId),
        isNull(salesSequenceEnrollments.deletedAt),
      ]
      if (opts.sequenceId) conditions.push(eq(salesSequenceEnrollments.sequenceId, opts.sequenceId))
      if (opts.personId) conditions.push(eq(salesSequenceEnrollments.personId, opts.personId))
      if (opts.status) {
        conditions.push(
          eq(salesSequenceEnrollments.status, validateSalesSequenceEnrollmentStatus(opts.status)),
        )
      }
      if (opts.exitReason) {
        const reason = validateSalesSequenceExitReason(opts.exitReason)
        if (reason !== null) conditions.push(eq(salesSequenceEnrollments.exitReason, reason))
      }
      const rows = await db
        .select()
        .from(salesSequenceEnrollments)
        .where(and(...conditions))
        .orderBy(
          opts.order === "asc"
            ? asc(salesSequenceEnrollments.createdAt)
            : desc(salesSequenceEnrollments.createdAt),
        )
        .limit(limit + 1)
      const hasMore = rows.length > limit
      const data = hasMore ? rows.slice(0, limit) : rows
      const last = data[data.length - 1]
      return { data, pagination: { nextCursor: hasMore ? (last?.id ?? null) : null, limit } }
    },

    async updateEnrollment(
      db: Database,
      workspaceId: string,
      id: string,
      patch: UpdateSalesSequenceEnrollmentInput,
    ): Promise<SalesSequenceEnrollment | null> {
      const values: Record<string, unknown> = { ...patch, updatedAt: new Date() }
      if (patch.status !== undefined) {
        values.status = validateSalesSequenceEnrollmentStatus(patch.status)
      }
      if (patch.exitReason !== undefined) {
        values.exitReason = validateSalesSequenceExitReason(patch.exitReason)
      }
      const rows = await db
        .update(salesSequenceEnrollments)
        .set(values)
        .where(
          and(
            eq(salesSequenceEnrollments.id, id),
            eq(salesSequenceEnrollments.workspaceId, workspaceId),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    /** Atomic counter bump, so two concurrent step runs cannot lose a send. */
    async incrementSentCount(
      db: Database,
      workspaceId: string,
      id: string,
    ): Promise<SalesSequenceEnrollment | null> {
      const rows = await db
        .update(salesSequenceEnrollments)
        .set({
          sentCount: sql`${salesSequenceEnrollments.sentCount} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(salesSequenceEnrollments.id, id),
            eq(salesSequenceEnrollments.workspaceId, workspaceId),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    /**
     * EXIT LOOKUP: every still-running enrollment this inbound signal
     * should stop. A reply arrives as an email thread; a bounce or an
     * unsubscribe arrives as a person or an address. Matching on any of
     * the three, rather than insisting on one, is what keeps the module's
     * one hard promise ("never email somebody who replied") robust to a
     * provider that only gives us part of the picture.
     */
    async findActiveEnrollmentsByTarget(
      db: Database,
      workspaceId: string,
      target: { threadId?: string | null; personId?: string | null; emailAddress?: string | null },
    ): Promise<SalesSequenceEnrollment[]> {
      const identity: SQL[] = []
      if (target.threadId) identity.push(eq(salesSequenceEnrollments.threadId, target.threadId))
      if (target.personId) identity.push(eq(salesSequenceEnrollments.personId, target.personId))
      if (target.emailAddress) {
        identity.push(
          eq(
            salesSequenceEnrollments.emailAddress,
            normalizeSalesSequenceEmail(target.emailAddress),
          ),
        )
      }
      if (identity.length === 0) return []
      const match = identity.length === 1 ? identity[0] : or(...identity)
      if (!match) return []
      return db
        .select()
        .from(salesSequenceEnrollments)
        .where(
          and(
            eq(salesSequenceEnrollments.workspaceId, workspaceId),
            inArray(salesSequenceEnrollments.status, ["active", "paused"]),
            isNull(salesSequenceEnrollments.deletedAt),
            match,
          ),
        )
        .orderBy(asc(salesSequenceEnrollments.createdAt))
    },

    /**
     * Workspace-wide suppression, derived from the enrollment rows rather
     * than from a consent table this module does not own: somebody who
     * unsubscribed from — or hard-bounced in — ANY sequence must not be
     * enrolled into another one.
     */
    async findSuppression(
      db: Database,
      workspaceId: string,
      target: { personId?: string | null; emailAddress?: string | null },
    ): Promise<SalesSequenceEnrollment | null> {
      const identity: SQL[] = []
      if (target.personId) identity.push(eq(salesSequenceEnrollments.personId, target.personId))
      if (target.emailAddress) {
        identity.push(
          eq(
            salesSequenceEnrollments.emailAddress,
            normalizeSalesSequenceEmail(target.emailAddress),
          ),
        )
      }
      if (identity.length === 0) return null
      const match = identity.length === 1 ? identity[0] : or(...identity)
      if (!match) return null
      const rows = await db
        .select()
        .from(salesSequenceEnrollments)
        .where(
          and(
            eq(salesSequenceEnrollments.workspaceId, workspaceId),
            inArray(salesSequenceEnrollments.exitReason, [
              ...SALES_SEQUENCE_SUPPRESSING_EXIT_REASONS,
            ]),
            match,
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },

    /* ------------------------------- step runs ------------------------------ */

    /**
     * IDEMPOTENT step claim — the send-once guarantee.
     * `sequence_step_runs_step_uidx` is UNIQUE over
     * (enrollment_id, step_index): the first attempt inserts a `running`
     * row and gets `claimed: true`; a retried job conflicts, gets
     * `claimed: false` plus the previous outcome, and must not send.
     */
    async claimStepRun(
      db: Database,
      workspaceId: string,
      input: ClaimSalesSequenceStepRunInput,
    ): Promise<{ run: SalesSequenceStepRun; claimed: boolean }> {
      if (!Number.isInteger(input.stepIndex) || input.stepIndex < 0) {
        throw new SalesSequenceDefinitionError("stepIndex must be a non-negative integer")
      }
      if (!isSalesSequenceStepType(input.stepType)) {
        throw new SalesSequenceDefinitionError(`unknown step type '${String(input.stepType)}'`)
      }
      const inserted = await db
        .insert(salesSequenceStepRuns)
        .values({
          workspaceId,
          enrollmentId: input.enrollmentId,
          stepId: input.stepId ?? null,
          stepIndex: input.stepIndex,
          stepType: input.stepType,
          status: "running",
          actorId: input.actorId ?? null,
          actorRole: input.actorRole ?? null,
        })
        .onConflictDoNothing({
          target: [salesSequenceStepRuns.enrollmentId, salesSequenceStepRuns.stepIndex],
        })
        .returning()
      const created = inserted[0]
      if (created) return { run: created, claimed: true }

      const existing = await db
        .select()
        .from(salesSequenceStepRuns)
        .where(
          and(
            eq(salesSequenceStepRuns.workspaceId, workspaceId),
            eq(salesSequenceStepRuns.enrollmentId, input.enrollmentId),
            eq(salesSequenceStepRuns.stepIndex, input.stepIndex),
          ),
        )
        .limit(1)
      const row = existing[0]
      if (!row) throw new SalesSequenceDefinitionError("sequence_step_runs: conflict without a row")
      return { run: row, claimed: false }
    },

    async completeStepRun(
      db: Database,
      workspaceId: string,
      id: string,
      patch: CompleteSalesSequenceStepRunInput,
    ): Promise<SalesSequenceStepRun | null> {
      if (patch.status !== undefined && !isSalesSequenceStepRunStatus(patch.status)) {
        throw new SalesSequenceDefinitionError(`unknown step run status '${patch.status}'`)
      }
      const rows = await db
        .update(salesSequenceStepRuns)
        .set({ ...patch, finishedAt: new Date(), updatedAt: new Date() })
        .where(
          and(eq(salesSequenceStepRuns.id, id), eq(salesSequenceStepRuns.workspaceId, workspaceId)),
        )
        .returning()
      return rows[0] ?? null
    },

    async listStepRuns(
      db: Database,
      workspaceId: string,
      enrollmentId: string,
    ): Promise<SalesSequenceStepRun[]> {
      return db
        .select()
        .from(salesSequenceStepRuns)
        .where(
          and(
            eq(salesSequenceStepRuns.workspaceId, workspaceId),
            eq(salesSequenceStepRuns.enrollmentId, enrollmentId),
          ),
        )
        .orderBy(asc(salesSequenceStepRuns.stepIndex))
    },

    /* --------------------------------- stats -------------------------------- */

    /**
     * Per-enrollment and per-step counters (spec 47 §3), aggregated from
     * the run table rather than denormalised onto the definition. Counters
     * on a definition drift the moment two workers finish a step at once;
     * a GROUP BY over an index cannot.
     *
     * Opens and clicks are deliberately absent: P0 ships no tracking pixel
     * and no link rewriting, so there is nothing honest to report.
     */
    async sequenceStats(
      db: Database,
      workspaceId: string,
      sequenceId: string,
    ): Promise<{
      enrollments: { status: string; exitReason: string | null; count: number }[]
      steps: { stepIndex: number; stepType: string; status: string; count: number }[]
    }> {
      const enrollments = await db
        .select({
          status: salesSequenceEnrollments.status,
          exitReason: salesSequenceEnrollments.exitReason,
          count: count(),
        })
        .from(salesSequenceEnrollments)
        .where(
          and(
            eq(salesSequenceEnrollments.workspaceId, workspaceId),
            eq(salesSequenceEnrollments.sequenceId, sequenceId),
            isNull(salesSequenceEnrollments.deletedAt),
          ),
        )
        .groupBy(salesSequenceEnrollments.status, salesSequenceEnrollments.exitReason)

      const steps = await db
        .select({
          stepIndex: salesSequenceStepRuns.stepIndex,
          stepType: salesSequenceStepRuns.stepType,
          status: salesSequenceStepRuns.status,
          count: count(),
        })
        .from(salesSequenceStepRuns)
        .innerJoin(
          salesSequenceEnrollments,
          eq(salesSequenceStepRuns.enrollmentId, salesSequenceEnrollments.id),
        )
        .where(
          and(
            eq(salesSequenceStepRuns.workspaceId, workspaceId),
            eq(salesSequenceEnrollments.sequenceId, sequenceId),
          ),
        )
        .groupBy(
          salesSequenceStepRuns.stepIndex,
          salesSequenceStepRuns.stepType,
          salesSequenceStepRuns.status,
        )
        .orderBy(asc(salesSequenceStepRuns.stepIndex))

      return { enrollments, steps }
    },
  }
}

export type SalesSequencesRepository = ReturnType<typeof createSalesSequencesRepository>
