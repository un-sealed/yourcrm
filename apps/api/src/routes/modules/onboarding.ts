import { roleInWorkspace, type Session } from "@yourcrm/auth"
import {
  createOnboardingService,
  onboardingProgressSchema,
  type OnboardingService,
  type OnboardingServiceContext,
  type OnboardingStore,
  type SampleDataPort,
  type SampleDataRecord,
} from "@yourcrm/crm/src/onboarding"
import { createDealsService, type DealsStore } from "@yourcrm/crm/src/deals"
import { createPeopleService, type PeopleStore } from "@yourcrm/crm/src/people"
import { getDb, writeAudit, type Database } from "@yourcrm/database"
import {
  createOnboardingRepository,
  readSampleData,
  readStepCompletedAt,
} from "@yourcrm/database/src/repositories/onboarding-repository"
import type { OnboardingProgressRow } from "@yourcrm/database/src/schema/onboarding"
import { createPeopleRepository } from "@yourcrm/database/src/repositories/people-repository"
import type {
  CreatePersonInput,
  UpdatePersonInput,
} from "@yourcrm/database/src/repositories/people-repository"
import { createDealsRepository } from "@yourcrm/database/src/repositories/deals-repository"
import type {
  ChangeDealStageInput,
  CloseDealInput,
  CreateDealInput,
  UpdateDealInput,
} from "@yourcrm/database/src/repositories/deals-repository"
import { getEventBus } from "@yourcrm/events"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { errorEnvelope } from "@yourcrm/validation"
import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import type { AppEnv } from "../../hono-env"
import { requireSession } from "../../middleware/auth"

/**
 * Onboarding module (spec 42-onboarding, P0).
 *
 * Thin HTTP layer only: session from the auth middleware, straight into the
 * domain service. No business logic lives here — in particular, NONE of
 * these routes accept a request body, because there is nothing for a
 * client to legitimately assert about checklist state: completion is
 * always computed server-side from real data (see
 * `packages/crm/src/onboarding/service.ts`). A client cannot forge a
 * "step complete" write because no field anywhere in this contract carries
 * one.
 */

export const basePath = "/onboarding"

const progressEnvelope = z.object({ data: onboardingProgressSchema })

export type OnboardingRouteDeps = {
  service?: OnboardingService
}

function toProgressRecord(row: OnboardingProgressRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    dismissedAt: row.dismissedAt ? row.dismissedAt.toISOString() : null,
    dismissedBy: row.dismissedBy,
    stepCompletedAt: readStepCompletedAt(row),
    sampleData: readSampleData(row),
    sampleDataSeededAt: row.sampleDataSeededAt ? row.sampleDataSeededAt.toISOString() : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Adapts the drizzle repository to the `OnboardingStore` port. */
function defaultStore(db: Database): OnboardingStore {
  const repository = createOnboardingRepository()
  return {
    getSignals: (workspaceId) => repository.getSignals(db, workspaceId),
    getOrCreateProgress: async (workspaceId, actorId) =>
      toProgressRecord(await repository.getOrCreate(db, workspaceId, actorId)),
    markStepObservedDone: async (workspaceId, stepKey, atIso) =>
      toProgressRecord(await repository.markStepObservedDone(db, workspaceId, stepKey, atIso)),
    setDismissed: async (workspaceId, dismissed, actorId) =>
      toProgressRecord(await repository.setDismissed(db, workspaceId, dismissed, actorId)),
    setSampleData: async (workspaceId, records, actorId) =>
      toProgressRecord(await repository.setSampleData(db, workspaceId, records, actorId)),
  }
}

/**
 * Sample-data seeding, implemented by calling the People and Deals modules'
 * OWN domain services (never by writing to their tables) — the same
 * services `apps/api/src/routes/modules/people.ts` / `deals.ts` wire up.
 * Every created row is tagged in `notes` and its id recorded so it can be
 * found and removed later; removal goes through the same services'
 * `softDelete`, so it stays fully auditable and permission-checked.
 */
const SAMPLE_DATA_TAG = "Sample data created by YourCRM onboarding — safe to delete."

function peopleServiceFor(db: Database) {
  const repository = createPeopleRepository()
  const store: PeopleStore = {
    list: (workspaceId, query) =>
      repository.search(db, {
        workspaceId,
        limit: query.limit,
        cursor: query.cursor,
        order: query.order,
        query: query.query,
        status: query.status,
      }),
    findById: (workspaceId, id) => repository.findById(db, workspaceId, id),
    findWithContacts: (workspaceId, id) => repository.findWithContacts(db, workspaceId, id),
    create: (workspaceId, input, actorId) =>
      repository.create(db, workspaceId, input as unknown as CreatePersonInput, actorId),
    update: (workspaceId, id, input, actorId) =>
      repository.update(db, workspaceId, id, input as unknown as UpdatePersonInput, actorId),
    softDelete: async (workspaceId, id, actorId) => {
      await repository.softDelete(db, workspaceId, id, actorId)
    },
    restore: async (workspaceId, id) => {
      await repository.restore(db, workspaceId, id)
    },
  }
  return createPeopleService({
    store,
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
    events: getEventBus(),
  })
}

function dealsServiceFor(db: Database) {
  const repository = createDealsRepository()
  const store: DealsStore = {
    list: (workspaceId, query) =>
      repository.search(db, {
        workspaceId,
        limit: query.limit,
        cursor: query.cursor,
        order: query.order,
        query: query.query,
        stage: query.stage,
        pipelineId: query.pipelineId,
        sort: query.sort,
      }),
    findById: (workspaceId, id) => repository.findById(db, workspaceId, id),
    create: (workspaceId, input, actorId) =>
      repository.create(db, workspaceId, input as unknown as CreateDealInput, actorId),
    update: (workspaceId, id, input, actorId) =>
      repository.update(db, workspaceId, id, input as unknown as UpdateDealInput, actorId),
    changeStage: (workspaceId, id, input, actorId) =>
      repository.changeStage(
        db,
        workspaceId,
        id,
        input as unknown as ChangeDealStageInput,
        actorId,
      ),
    close: (workspaceId, id, input, actorId) => {
      const stage = (input as { stage?: string }).stage
      if (stage !== "won" && stage !== "lost") throw new Error("deals.close: unknown stage")
      return repository.close(
        db,
        workspaceId,
        id,
        input as unknown as CloseDealInput & { stage: "won" | "lost" },
        actorId,
      )
    },
    softDelete: async (workspaceId, id, actorId) => {
      await repository.softDelete(db, workspaceId, id, actorId)
    },
    restore: async (workspaceId, id) => {
      await repository.restore(db, workspaceId, id)
    },
  }
  return createDealsService({
    store,
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
    events: getEventBus(),
  })
}

function defaultSampleDataPort(db: Database): SampleDataPort {
  const people = peopleServiceFor(db)
  const deals = dealsServiceFor(db)
  return {
    async seed(ctx: OnboardingServiceContext): Promise<SampleDataRecord[]> {
      const created: SampleDataRecord[] = []
      const personOne = await people.create(ctx, {
        firstName: "Ada",
        lastName: "Sample",
        title: "Sample Contact",
        notes: SAMPLE_DATA_TAG,
      })
      created.push({ module: "person", recordId: personOne.id })
      const personTwo = await people.create(ctx, {
        firstName: "Grace",
        lastName: "Sample",
        title: "Sample Contact",
        notes: SAMPLE_DATA_TAG,
      })
      created.push({ module: "person", recordId: personTwo.id })

      const dealOne = await deals.create(ctx, {
        name: "(Sample) First deal",
        amount: 5000,
        personId: personOne.id,
        notes: SAMPLE_DATA_TAG,
      })
      created.push({ module: "deal", recordId: dealOne.id })
      const dealTwo = await deals.create(ctx, {
        name: "(Sample) Renewal",
        amount: 12000,
        personId: personTwo.id,
        notes: SAMPLE_DATA_TAG,
      })
      created.push({ module: "deal", recordId: dealTwo.id })
      return created
    },
    async remove(ctx: OnboardingServiceContext, records: SampleDataRecord[]): Promise<void> {
      for (const record of records) {
        if (record.module === "person") await people.softDelete(ctx, record.recordId)
        else if (record.module === "deal") await deals.softDelete(ctx, record.recordId)
      }
    },
  }
}

function defaultService(): OnboardingService {
  const db = getDb()
  return createOnboardingService({
    store: defaultStore(db),
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
    events: getEventBus(),
    sampleData: defaultSampleDataPort(db),
  })
}

function serviceContextOf(c: Context<AppEnv>) {
  const session = c.get("session") as Session | null
  return {
    workspaceId: session?.workspaceId ?? "",
    actorId: session?.user.id ?? "",
    role: session ? roleInWorkspace(session) : "viewer",
    correlationId: c.get("requestId") as string | undefined,
  }
}

function mapError(c: Context<AppEnv>, err: unknown) {
  const requestId = c.get("requestId") as string | undefined
  if (err instanceof PermissionDeniedError) {
    return c.json(errorEnvelope("FORBIDDEN", err.message, requestId), 403)
  }
  if (err instanceof Error && (err as { code?: string }).code === "NOT_FOUND") {
    return c.json(errorEnvelope("NOT_FOUND", err.message, requestId), 404)
  }
  if (err instanceof Error && (err as { code?: string }).code === "NOT_IMPLEMENTED") {
    return c.json(errorEnvelope("NOT_IMPLEMENTED", err.message, requestId), 501)
  }
  throw err
}

export function createRoutes(deps: OnboardingRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  let cached: OnboardingService | null = deps.service ?? null
  const service = () => (cached ??= defaultService())

  app.get("/progress", requireSession(), async (c) => {
    try {
      const progress = await service().getProgress(serviceContextOf(c))
      return c.json({ data: progress })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/dismiss", requireSession(), async (c) => {
    try {
      const progress = await service().dismiss(serviceContextOf(c))
      return c.json({ data: progress })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/reopen", requireSession(), async (c) => {
    try {
      const progress = await service().reopen(serviceContextOf(c))
      return c.json({ data: progress })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/sample-data", requireSession(), async (c) => {
    try {
      const progress = await service().seedSampleData(serviceContextOf(c))
      return c.json({ data: progress }, 201)
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.delete("/sample-data", requireSession(), async (c) => {
    try {
      const progress = await service().removeSampleData(serviceContextOf(c))
      return c.json({ data: progress })
    } catch (err) {
      return mapError(c, err)
    }
  })

  return app
}

export const openApiPaths = {
  "/api/v1/onboarding/progress": {
    get: {
      summary: "Get the onboarding checklist, recomputed from real workspace data",
      operationId: "getOnboardingProgress",
    },
  },
  "/api/v1/onboarding/dismiss": {
    post: {
      summary: "Dismiss the onboarding checklist (owner/admin)",
      operationId: "dismissOnboarding",
    },
  },
  "/api/v1/onboarding/reopen": {
    post: {
      summary: "Reopen the onboarding checklist (owner/admin)",
      operationId: "reopenOnboarding",
    },
  },
  "/api/v1/onboarding/sample-data": {
    post: {
      summary: "Seed removable sample people/deals for this workspace (owner/admin)",
      operationId: "seedOnboardingSampleData",
    },
    delete: {
      summary: "Remove previously seeded sample data (owner/admin)",
      operationId: "removeOnboardingSampleData",
    },
  },
}

export { progressEnvelope }
