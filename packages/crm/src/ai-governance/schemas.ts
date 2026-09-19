import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"

/**
 * AI governance zod schemas (spec 38-ai-governance, P0).
 *
 * Services validate inputs with these; API routes reuse them at the HTTP
 * boundary via `@hono/zod-validator`.
 *
 * The vocabulary here is the canonical one for the domain layer and is
 * mirrored — never widened — in `@yourcrm/database`'s
 * `schema/ai-governance.ts`, exactly as the automation module mirrors its
 * action types. `@yourcrm/crm` has no database dependency, so the lists
 * cannot simply be imported; keep the two in step.
 */

/* ------------------------------- vocabulary ------------------------------- */

/**
 * What an AI may propose to do. Each one maps to a `@yourcrm/permissions`
 * action in `access.ts` — there is no AI-specific permission model.
 *
 * EXTENSION POINT: a new member needs a matching entry in
 * `AI_ACTION_PERMISSIONS`, or the action cannot be checked and must not
 * exist.
 */
export const AI_ACTION_TYPES = ["create", "update", "delete", "send_external"] as const

export type AiActionType = (typeof AI_ACTION_TYPES)[number]

export const aiActionTypeSchema = z.enum(AI_ACTION_TYPES)

export const AI_ACTION_REQUEST_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "applied",
  "reverted",
  "expired",
] as const

export type AiActionRequestStatus = (typeof AI_ACTION_REQUEST_STATUSES)[number]

export const aiActionRequestStatusSchema = z.enum(AI_ACTION_REQUEST_STATUSES)

/** Who proposed an action. Only a `user` may ever decide one. */
export const AI_ACTOR_TYPES = ["user", "agent"] as const

export type AiActorType = (typeof AI_ACTOR_TYPES)[number]

export const aiActorTypeSchema = z.enum(AI_ACTOR_TYPES)

export const AI_POLICY_MODES = ["require_approval", "auto_apply", "forbidden"] as const

export type AiPolicyMode = (typeof AI_POLICY_MODES)[number]

export const aiPolicyModeSchema = z.enum(AI_POLICY_MODES)

/** Scope wildcard: "any object" / "any action". */
export const AI_POLICY_WILDCARD = "*"

/**
 * How long a pending proposal stays actionable. An AI proposal that
 * nobody looked at for three days describes a world that has moved on, so
 * it expires instead of waiting to surprise somebody.
 */
export const AI_ACTION_DEFAULT_TTL_MINUTES = 3 * 24 * 60

const objectTypeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, "objectType must be lower snake_case")

const policyObjectTypeSchema = z.union([z.literal(AI_POLICY_WILDCARD), objectTypeSchema])

const policyActionSchema = z.union([z.literal(AI_POLICY_WILDCARD), aiActionTypeSchema])

const recordIdSchema = z.string().trim().min(1).max(128)

/* --------------------------------- requests ------------------------------- */

/**
 * A proposed mutation. The shape is deliberately strict:
 *
 *  - `rationale` is REQUIRED. An AI change nobody can explain is not one a
 *    human can meaningfully approve.
 *  - `update`/`delete` must name the record; `create` must not.
 *  - `update` must carry `after` (what would change) and `delete` must
 *    carry `before` (what would be lost), so the diff view has something
 *    to show and revert has something to restore.
 */
export const createAiActionRequestSchema = z
  .object({
    objectType: objectTypeSchema,
    recordId: recordIdSchema.nullish(),
    action: aiActionTypeSchema,
    /** State as the proposer read it. Revert restores this. */
    before: z.unknown().optional(),
    /** State the proposer wants. Apply writes this. */
    after: z.unknown().optional(),
    rationale: z.string().trim().min(1).max(4000),
    model: z.string().trim().min(1).max(128).nullish(),
    runId: z.string().trim().min(1).max(128).nullish(),
    agentId: z.string().trim().min(1).max(128).nullish(),
    expiresInMinutes: z
      .number()
      .int()
      .min(1)
      .max(30 * 24 * 60)
      .nullish(),
  })
  .superRefine((value, ctx) => {
    const hasRecord = value.recordId != null && value.recordId !== ""
    if (value.action === "create" && hasRecord) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recordId"],
        message: "a create proposal must not name an existing record",
      })
    }
    if (value.action !== "create" && !hasRecord) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recordId"],
        message: `a ${value.action} proposal must name the record it targets`,
      })
    }
    if ((value.action === "create" || value.action === "update") && value.after === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["after"],
        message: "a create or update proposal must say what it would write",
      })
    }
    if (value.action === "update" && value.before === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["before"],
        message: "an update proposal must record the state it read, so it can be reverted",
      })
    }
    if (value.action === "delete" && value.before === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["before"],
        message: "a delete proposal must record what would be lost",
      })
    }
  })

export type CreateAiActionRequestInput = z.infer<typeof createAiActionRequestSchema>

/** Approving may carry a note; rejecting must say why. */
export const approveAiActionSchema = z.object({
  reason: z.string().trim().max(2000).nullish(),
})

export type ApproveAiActionInput = z.infer<typeof approveAiActionSchema>

export const rejectAiActionSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
})

export type RejectAiActionInput = z.infer<typeof rejectAiActionSchema>

export const revertAiActionSchema = z.object({
  reason: z.string().trim().max(2000).nullish(),
})

export type RevertAiActionInput = z.infer<typeof revertAiActionSchema>

export const aiActionRequestQuerySchema = paginationQuerySchema.extend({
  status: aiActionRequestStatusSchema.optional(),
  objectType: objectTypeSchema.optional(),
  recordId: recordIdSchema.optional(),
  runId: z.string().trim().min(1).max(128).optional(),
  actorId: z.string().trim().min(1).max(128).optional(),
})

export type AiActionRequestQuery = z.infer<typeof aiActionRequestQuerySchema>

/* --------------------------------- policies ------------------------------- */

export const createAiPolicySchema = z.object({
  objectType: policyObjectTypeSchema.default(AI_POLICY_WILDCARD),
  action: policyActionSchema.default(AI_POLICY_WILDCARD),
  mode: aiPolicyModeSchema,
  description: z.string().trim().max(2000).nullish(),
  enabled: z.boolean().default(true),
})

export type CreateAiPolicyInput = z.infer<typeof createAiPolicySchema>

export const updateAiPolicySchema = z
  .object({
    objectType: policyObjectTypeSchema,
    action: policyActionSchema,
    mode: aiPolicyModeSchema,
    description: z.string().trim().max(2000).nullish(),
    enabled: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateAiPolicyInput = z.infer<typeof updateAiPolicySchema>

export const aiPolicyQuerySchema = paginationQuerySchema.extend({
  objectType: policyObjectTypeSchema.optional(),
  mode: aiPolicyModeSchema.optional(),
})

export type AiPolicyQuery = z.infer<typeof aiPolicyQuerySchema>

/* -------------------------------- responses ------------------------------- */

export const aiActionRequestSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  actorType: z.string(),
  actorId: z.string(),
  agentId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  runId: z.string().nullable().optional(),
  correlationId: z.string().nullable().optional(),
  objectType: z.string(),
  recordId: z.string().nullable().optional(),
  action: z.string(),
  before: z.unknown().nullable().optional(),
  after: z.unknown().nullable().optional(),
  rationale: z.string().nullable().optional(),
  status: z.string(),
  policyMode: z.string(),
  requestedRole: z.string().nullable().optional(),
  expiresAt: z.union([z.string(), z.date()]).nullable().optional(),
  decidedAt: z.union([z.string(), z.date()]).nullable().optional(),
  appliedAt: z.union([z.string(), z.date()]).nullable().optional(),
  applyError: z.string().nullable().optional(),
  revertedAt: z.union([z.string(), z.date()]).nullable().optional(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
})

export const aiActionApprovalSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  decision: z.string(),
  approverId: z.string(),
  approverRole: z.string().nullable().optional(),
  requesterRole: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  createdAt: z.union([z.string(), z.date()]),
})

export const aiPolicySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  objectType: z.string(),
  action: z.string(),
  mode: z.string(),
  description: z.string().nullable().optional(),
  enabled: z.boolean(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
})

export type AiActionRequestDto = z.infer<typeof aiActionRequestSchema>
export type AiActionApprovalDto = z.infer<typeof aiActionApprovalSchema>
export type AiPolicyDto = z.infer<typeof aiPolicySchema>
