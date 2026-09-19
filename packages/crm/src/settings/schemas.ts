import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"

/**
 * Settings zod schemas (specs 40 + 41, P0). Services validate with these;
 * API routes reuse the same objects at the HTTP boundary, so client and
 * server can never disagree about what a valid patch is.
 *
 * Names are prefixed (`workspaceSettingsPatchSchema`, not `settingsSchema`)
 * because one generated `export *` barrel covers every CRM module.
 */

export const WORKSPACE_ROLE_VALUES = ["owner", "admin", "member", "viewer"] as const

export const workspaceRoleSchema = z.enum(WORKSPACE_ROLE_VALUES)

export type WorkspaceRoleValue = z.infer<typeof workspaceRoleSchema>

/** IANA zone id — validated by shape, not by a bundled tz database. */
const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_+\-/]+$/, "timezone must be an IANA zone id (e.g. Europe/Berlin)")

const currencySchema = z
  .string()
  .trim()
  .length(3, "currency must be a 3-letter ISO 4217 code")
  .regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter ISO 4217 code")
  .transform((value) => value.toUpperCase())

/** Token form (YYYY/MM/DD/D/M), not a strftime string. */
const dateFormatSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[YMD][YMD\-/.\s]*$/, "date format must use Y, M and D tokens (e.g. DD/MM/YYYY)")

const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "brand colour must be a #rrggbb hex value")

export const workspaceSettingsPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    timezone: timezoneSchema,
    currency: currencySchema,
    dateFormat: dateFormatSchema,
    logoUrl: z.string().trim().url().max(2048).nullable(),
    brandColor: hexColorSchema.nullable(),
    supportEmail: z.string().trim().email().max(320).nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type WorkspaceSettingsPatchInput = z.infer<typeof workspaceSettingsPatchSchema>

export const workspaceMemberQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  role: workspaceRoleSchema.optional(),
  status: z.enum(["active", "inactive"]).optional(),
})

export type WorkspaceMemberQueryInput = z.infer<typeof workspaceMemberQuerySchema>

export const workspaceMemberRolePatchSchema = z.object({ role: workspaceRoleSchema })

export type WorkspaceMemberRolePatchInput = z.infer<typeof workspaceMemberRolePatchSchema>

export const workspaceInviteCreateSchema = z.object({
  email: z.string().trim().email().max(320).toLowerCase(),
  role: workspaceRoleSchema.default("member"),
})

export type WorkspaceInviteCreateInput = z.infer<typeof workspaceInviteCreateSchema>

export const workspaceInviteQuerySchema = paginationQuerySchema.extend({
  state: z.enum(["pending", "all"]).default("pending"),
})

export type WorkspaceInviteQueryInput = z.infer<typeof workspaceInviteQuerySchema>

export const workspaceTeamCreateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  /** Optional: derived from the name when omitted. */
  slug: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lower-kebab-case")
    .optional(),
  description: z.string().trim().max(2000).nullish(),
})

export type WorkspaceTeamCreateInput = z.infer<typeof workspaceTeamCreateSchema>

export const workspaceTeamPatchSchema = workspaceTeamCreateSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type WorkspaceTeamPatchInput = z.infer<typeof workspaceTeamPatchSchema>

export const workspaceTeamQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
})

export type WorkspaceTeamQueryInput = z.infer<typeof workspaceTeamQuerySchema>

export const workspaceTeamMemberAddSchema = z.object({
  membershipId: z.string().uuid(),
  teamRole: z.enum(["member", "lead"]).default("member"),
})

export type WorkspaceTeamMemberAddInput = z.infer<typeof workspaceTeamMemberAddSchema>

export const workspaceAuditQuerySchema = paginationQuerySchema.extend({
  action: z.string().trim().max(64).optional(),
  object: z.string().trim().max(64).optional(),
  actorId: z.string().uuid().optional(),
  recordId: z.string().uuid().optional(),
  source: z.enum(["user", "automation", "ai", "integration", "mcp"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  query: z.string().trim().max(255).optional(),
})

export type WorkspaceAuditQueryInput = z.infer<typeof workspaceAuditQuerySchema>

export const dataRequestCreateSchema = z.object({
  kind: z.enum(["export", "deletion"]),
  subjectType: z.literal("person").default("person"),
  subjectId: z.string().uuid(),
  reason: z.string().trim().max(2000).nullish(),
})

export type DataRequestCreateInput = z.infer<typeof dataRequestCreateSchema>

export const dataRequestQuerySchema = paginationQuerySchema.extend({
  kind: z.enum(["export", "deletion"]).optional(),
  status: z.enum(["pending", "fulfilled", "soft_deleted", "rejected"]).optional(),
})

export type DataRequestQueryInput = z.infer<typeof dataRequestQuerySchema>

// --- response shapes (OpenAPI + envelope assertions) -----------------------

export const workspaceSettingsSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  currency: z.string(),
  dateFormat: z.string(),
  logoUrl: z.string().nullable(),
  brandColor: z.string().nullable(),
  supportEmail: z.string().nullable(),
  updatedAt: z.string(),
})

export const workspaceMemberSchema = z.object({
  membershipId: z.string(),
  userId: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: z.string(),
  active: z.boolean(),
  joinedAt: z.string(),
  lastLoginAt: z.string().nullable(),
})

export const workspaceInviteSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  email: z.string(),
  role: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  invitedBy: z.string().nullable(),
  createdAt: z.string(),
})

export const workspaceTeamSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  memberCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const workspaceAuditSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  actorId: z.string().nullable(),
  action: z.string(),
  object: z.string(),
  recordId: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  correlationId: z.string().nullable(),
  source: z.string(),
  createdAt: z.string(),
})

export const dataRequestSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  kind: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  status: z.string(),
  reason: z.string().nullable(),
  requestedBy: z.string().nullable(),
  completedAt: z.string().nullable(),
  completedBy: z.string().nullable(),
  createdAt: z.string(),
})
