import { zValidator } from "@hono/zod-validator"
import {
  generateSessionToken,
  hashSessionToken,
  roleInWorkspace,
  type Session,
} from "@yourcrm/auth"
import {
  createComplianceService,
  createWorkspaceSettingsService,
  createWorkspaceTeamService,
  dataRequestCreateSchema,
  dataRequestQuerySchema,
  dataRequestSchema,
  workspaceAuditQuerySchema,
  workspaceAuditSchema,
  workspaceInviteCreateSchema,
  workspaceInviteQuerySchema,
  workspaceInviteSchema,
  workspaceMemberQuerySchema,
  workspaceMemberRolePatchSchema,
  workspaceMemberSchema,
  workspaceSettingsPatchSchema,
  workspaceSettingsSchema,
  workspaceTeamCreateSchema,
  workspaceTeamMemberAddSchema,
  workspaceTeamPatchSchema,
  workspaceTeamQuerySchema,
  workspaceTeamSchema,
  type ComplianceService,
  type WorkspaceSettingsService,
  type WorkspaceTeamService,
} from "@yourcrm/crm/src/settings"
import { getDb, writeAudit } from "@yourcrm/database"
import {
  createAuditLogReader,
  createDataRequestRepository,
} from "@yourcrm/database/src/repositories/compliance-repository"
import { createPeopleRepository } from "@yourcrm/database/src/repositories/people-repository"
import { createWorkspaceSettingsRepository } from "@yourcrm/database/src/repositories/settings-repository"
import { createWorkspaceTeamRepository } from "@yourcrm/database/src/repositories/teams-repository"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { errorEnvelope, paginatedEnvelopeSchema } from "@yourcrm/validation"
import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import { ZodError } from "zod"
import type { AppEnv } from "../../hono-env"
import { requireSession } from "../../middleware/auth"
import { zodToJsonSchema } from "../../openapi/zod-to-json-schema"

/**
 * Settings, security & compliance module (specs 40 + 41, P0).
 *
 * Thin HTTP layer: validate -> session -> domain service. Every escalation
 * rule, every audit row and every permission check lives in
 * `@yourcrm/crm/src/settings`, so an MCP tool or worker calling the same
 * service gets identical behaviour.
 *
 * TWO SECURITY PROPERTIES ARE VISIBLE IN THIS FILE:
 *
 *  1. **The audit log is read-only.** `/settings/audit` and
 *     `/settings/audit/:id` are registered with `app.get` and nothing else.
 *     There is no POST, PATCH, PUT or DELETE on an audit path anywhere in
 *     the API, the domain service has no method that could back one, and
 *     `0320_settings.sql` rejects UPDATE/DELETE/TRUNCATE on `audit_events`
 *     in Postgres. `settings.test.ts` asserts the routing half.
 *  2. **Invite tokens are generated here and hashed before storage.** The
 *     raw token is returned in the creation/resend response exactly once
 *     (so the caller can deliver the link) and is never persisted or logged;
 *     `hashSessionToken` is the same SHA-256 the session store uses.
 */

export const basePath = "/settings"

const settingsEnvelope = z.object({ data: workspaceSettingsSchema })
const memberListEnvelope = paginatedEnvelopeSchema(workspaceMemberSchema)
const inviteListEnvelope = paginatedEnvelopeSchema(workspaceInviteSchema)
const teamListEnvelope = paginatedEnvelopeSchema(workspaceTeamSchema)
const auditListEnvelope = paginatedEnvelopeSchema(workspaceAuditSchema)
const dataRequestListEnvelope = paginatedEnvelopeSchema(dataRequestSchema)

export type SettingsRouteDeps = {
  settings?: WorkspaceSettingsService
  teams?: WorkspaceTeamService
  compliance?: ComplianceService
}

function defaultSettingsService(): WorkspaceSettingsService {
  const db = getDb()
  const repository = createWorkspaceSettingsRepository()
  return createWorkspaceSettingsService({
    store: {
      getWorkspace: (workspaceId) => repository.getWorkspace(db, workspaceId),
      updateWorkspace: (workspaceId, patch, actorId) =>
        repository.updateWorkspace(db, workspaceId, patch, actorId),
      listMembers: (workspaceId, query) => repository.listMembers(db, workspaceId, query),
      findMember: (workspaceId, membershipId) =>
        repository.findMember(db, workspaceId, membershipId),
      countActiveOwners: (workspaceId) => repository.countActiveOwners(db, workspaceId),
      updateMemberRole: (workspaceId, membershipId, role, actorId) =>
        repository.updateMemberRole(db, workspaceId, membershipId, role, actorId),
      setMemberActive: (workspaceId, membershipId, active, actorId) =>
        repository.setMemberActive(db, workspaceId, membershipId, active, actorId),
      listInvites: (workspaceId, query) => repository.listInvites(db, workspaceId, query),
      findInvite: (workspaceId, id) => repository.findInvite(db, workspaceId, id),
      findPendingInviteByEmail: (workspaceId, email) =>
        repository.findPendingInviteByEmail(db, workspaceId, email),
      createInvite: (workspaceId, input, actorId) =>
        repository.createInvite(db, workspaceId, input, actorId),
      rotateInviteToken: (workspaceId, id, tokenHash, expiresAt, actorId) =>
        repository.rotateInviteToken(db, workspaceId, id, tokenHash, expiresAt, actorId),
      revokeInvite: (workspaceId, id, actorId) =>
        repository.revokeInvite(db, workspaceId, id, actorId),
    },
    // The session primitives: 32 CSPRNG bytes, stored only as SHA-256 hex.
    tokens: { generate: generateSessionToken, hash: hashSessionToken },
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
  })
}

function defaultTeamService(): WorkspaceTeamService {
  const db = getDb()
  const repository = createWorkspaceTeamRepository()
  return createWorkspaceTeamService({
    store: {
      list: (workspaceId, query) => repository.list(db, workspaceId, query),
      findById: (workspaceId, id) => repository.findById(db, workspaceId, id),
      create: (workspaceId, input, actorId) => repository.create(db, workspaceId, input, actorId),
      update: (workspaceId, id, input, actorId) =>
        repository.update(db, workspaceId, id, input, actorId),
      softDelete: (workspaceId, id, actorId) => repository.softDelete(db, workspaceId, id, actorId),
      listMembers: (workspaceId, teamId) => repository.listMembers(db, workspaceId, teamId),
      membershipExists: (workspaceId, membershipId) =>
        repository.membershipExists(db, workspaceId, membershipId),
      addMember: (workspaceId, teamId, membershipId, teamRole, actorId) =>
        repository.addMember(db, workspaceId, teamId, membershipId, teamRole, actorId),
      removeMember: (workspaceId, teamId, membershipId, actorId) =>
        repository.removeMember(db, workspaceId, teamId, membershipId, actorId),
    },
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
  })
}

function defaultComplianceService(): ComplianceService {
  const db = getDb()
  const auditLog = createAuditLogReader()
  const requests = createDataRequestRepository()
  // The data subject is reached through the PEOPLE module's repository —
  // this module never reads or writes another module's tables directly.
  const people = createPeopleRepository()
  return createComplianceService({
    auditLog: {
      list: (workspaceId, query) => auditLog.list(db, workspaceId, query),
      findById: (workspaceId, id) => auditLog.findById(db, workspaceId, id),
    },
    requests: {
      list: (workspaceId, query) => requests.list(db, workspaceId, query),
      findById: (workspaceId, id) => requests.findById(db, workspaceId, id),
      create: (workspaceId, input, actorId) => requests.create(db, workspaceId, input, actorId),
      markStatus: (workspaceId, id, status, actorId) =>
        requests.markStatus(db, workspaceId, id, status, actorId),
    },
    subjects: {
      load: async (workspaceId, subjectId) => {
        const found = await people.findWithContacts(db, workspaceId, subjectId)
        if (!found) return null
        return { person: found.person, emails: found.emails, phones: found.phones }
      },
      softDelete: async (workspaceId, subjectId, actorId) => {
        const found = await people.findById(db, workspaceId, subjectId)
        if (!found) return false
        await people.softDelete(db, workspaceId, subjectId, actorId)
        return true
      },
    },
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "user" })
    },
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

function invalid(c: Context, message: string, details?: unknown) {
  return c.json(
    errorEnvelope("VALIDATION_ERROR", message, c.req.header("x-request-id") ?? undefined, details),
    400,
  )
}

/** Shared zValidator hook: one error envelope shape for every endpoint. */
function onInvalid(kind: "query parameters" | "request body") {
  // `Context` (not `Context<AppEnv>`): zValidator types its hook against the
  // generic Hono env, and this helper only reads the request id header.
  return (result: { success: boolean; error?: ZodError }, c: Context) => {
    if (!result.success) return invalid(c, `Invalid ${kind}`, result.error?.flatten())
    return undefined
  }
}

function mapError(c: Context<AppEnv>, err: unknown) {
  const requestId = c.get("requestId") as string | undefined
  if (err instanceof PermissionDeniedError) {
    return c.json(errorEnvelope("FORBIDDEN", err.message, requestId), 403)
  }
  if (err instanceof ZodError) {
    return c.json(
      errorEnvelope("VALIDATION_ERROR", "Invalid request", requestId, err.flatten()),
      400,
    )
  }
  const code = err instanceof Error ? (err as { code?: string }).code : undefined
  if (code === "NOT_FOUND") {
    return c.json(errorEnvelope("NOT_FOUND", (err as Error).message, requestId), 404)
  }
  if (code === "CONFLICT") {
    return c.json(errorEnvelope("CONFLICT", (err as Error).message, requestId), 409)
  }
  if (code === "VALIDATION_ERROR") {
    return c.json(errorEnvelope("VALIDATION_ERROR", (err as Error).message, requestId), 400)
  }
  throw err
}

export function createRoutes(deps: SettingsRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  // Lazy wiring: route construction must never touch the database (the
  // registry test mounts every module without Postgres).
  let settingsCache: WorkspaceSettingsService | null = deps.settings ?? null
  let teamCache: WorkspaceTeamService | null = deps.teams ?? null
  let complianceCache: ComplianceService | null = deps.compliance ?? null
  const settings = () => (settingsCache ??= defaultSettingsService())
  const teams = () => (teamCache ??= defaultTeamService())
  const compliance = () => (complianceCache ??= defaultComplianceService())

  // --- workspace profile ---------------------------------------------------

  app.get("/workspace", requireSession(), async (c) => {
    try {
      return c.json({ data: await settings().getWorkspace(serviceContextOf(c)) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.patch(
    "/workspace",
    requireSession(),
    zValidator("json", workspaceSettingsPatchSchema, onInvalid("request body")),
    async (c) => {
      try {
        const updated = await settings().updateWorkspace(serviceContextOf(c), c.req.valid("json"))
        return c.json({ data: updated })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  // --- members -------------------------------------------------------------

  app.get(
    "/members",
    requireSession(),
    zValidator("query", workspaceMemberQuerySchema, onInvalid("query parameters")),
    async (c) => {
      try {
        return c.json(await settings().listMembers(serviceContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.patch(
    "/members/:membershipId/role",
    requireSession(),
    zValidator("json", workspaceMemberRolePatchSchema, onInvalid("request body")),
    async (c) => {
      try {
        const member = await settings().changeMemberRole(
          serviceContextOf(c),
          c.req.param("membershipId"),
          c.req.valid("json"),
        )
        return c.json({ data: member })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post("/members/:membershipId/deactivate", requireSession(), async (c) => {
    try {
      const member = await settings().setMemberActive(
        serviceContextOf(c),
        c.req.param("membershipId"),
        false,
      )
      return c.json({ data: member })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post("/members/:membershipId/reactivate", requireSession(), async (c) => {
    try {
      const member = await settings().setMemberActive(
        serviceContextOf(c),
        c.req.param("membershipId"),
        true,
      )
      return c.json({ data: member })
    } catch (err) {
      return mapError(c, err)
    }
  })

  // --- invitations ---------------------------------------------------------

  app.get(
    "/invites",
    requireSession(),
    zValidator("query", workspaceInviteQuerySchema, onInvalid("query parameters")),
    async (c) => {
      try {
        return c.json(await settings().listInvites(serviceContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/invites",
    requireSession(),
    zValidator("json", workspaceInviteCreateSchema, onInvalid("request body")),
    async (c) => {
      try {
        const created = await settings().invite(serviceContextOf(c), c.req.valid("json"))
        // `token` appears here and nowhere else, ever.
        return c.json({ data: { ...created.invite, token: created.token } }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post("/invites/:id/resend", requireSession(), async (c) => {
    try {
      const resent = await settings().resendInvite(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { ...resent.invite, token: resent.token } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.delete("/invites/:id", requireSession(), async (c) => {
    try {
      return c.json({ data: await settings().revokeInvite(serviceContextOf(c), c.req.param("id")) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  // --- teams ---------------------------------------------------------------

  app.get(
    "/teams",
    requireSession(),
    zValidator("query", workspaceTeamQuerySchema, onInvalid("query parameters")),
    async (c) => {
      try {
        return c.json(await teams().list(serviceContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/teams",
    requireSession(),
    zValidator("json", workspaceTeamCreateSchema, onInvalid("request body")),
    async (c) => {
      try {
        return c.json({ data: await teams().create(serviceContextOf(c), c.req.valid("json")) }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/teams/:id", requireSession(), async (c) => {
    try {
      const found = await teams().get(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { ...found.team, members: found.members } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.patch(
    "/teams/:id",
    requireSession(),
    zValidator("json", workspaceTeamPatchSchema, onInvalid("request body")),
    async (c) => {
      try {
        const updated = await teams().update(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: updated })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/teams/:id", requireSession(), async (c) => {
    try {
      await teams().softDelete(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: { deleted: true } })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.post(
    "/teams/:id/members",
    requireSession(),
    zValidator("json", workspaceTeamMemberAddSchema, onInvalid("request body")),
    async (c) => {
      try {
        const added = await teams().addMember(
          serviceContextOf(c),
          c.req.param("id"),
          c.req.valid("json"),
        )
        return c.json({ data: added }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.delete("/teams/:id/members/:membershipId", requireSession(), async (c) => {
    try {
      const result = await teams().removeMember(
        serviceContextOf(c),
        c.req.param("id"),
        c.req.param("membershipId"),
      )
      return c.json({ data: result })
    } catch (err) {
      return mapError(c, err)
    }
  })

  // --- audit log (GET ONLY — see the file header) ---------------------------

  app.get(
    "/audit",
    requireSession(),
    zValidator("query", workspaceAuditQuerySchema, onInvalid("query parameters")),
    async (c) => {
      try {
        return c.json(await compliance().listAuditEvents(serviceContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/audit/:id", requireSession(), async (c) => {
    try {
      const found = await compliance().getAuditEvent(serviceContextOf(c), c.req.param("id"))
      if (!found) {
        return c.json(
          errorEnvelope(
            "NOT_FOUND",
            `audit event ${c.req.param("id")} not found`,
            c.get("requestId") as string | undefined,
          ),
          404,
        )
      }
      return c.json({ data: found })
    } catch (err) {
      return mapError(c, err)
    }
  })

  // --- data requests (GDPR / DPDP) -----------------------------------------

  app.get(
    "/data-requests",
    requireSession(),
    zValidator("query", dataRequestQuerySchema, onInvalid("query parameters")),
    async (c) => {
      try {
        return c.json(
          await compliance().listDataRequests(serviceContextOf(c), c.req.valid("query")),
        )
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post(
    "/data-requests",
    requireSession(),
    zValidator("json", dataRequestCreateSchema, onInvalid("request body")),
    async (c) => {
      try {
        const created = await compliance().createDataRequest(
          serviceContextOf(c),
          c.req.valid("json"),
        )
        return c.json({ data: created }, 201)
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post("/data-requests/:id/export", requireSession(), async (c) => {
    try {
      const payload = await compliance().fulfilExportRequest(serviceContextOf(c), c.req.param("id"))
      return c.json({ data: payload })
    } catch (err) {
      return mapError(c, err)
    }
  })

  return app
}

export const openApiPaths = {
  "/api/v1/settings/workspace": {
    get: { summary: "Get the workspace profile", operationId: "getWorkspaceSettings" },
    patch: {
      summary: "Update the workspace profile (name, timezone, currency, format, branding)",
      operationId: "updateWorkspaceSettings",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(workspaceSettingsPatchSchema) } },
      },
    },
  },
  "/api/v1/settings/members": {
    get: { summary: "List workspace members", operationId: "listWorkspaceMembers" },
  },
  "/api/v1/settings/members/{membershipId}/role": {
    patch: {
      summary: "Change a member's workspace role (escalation-guarded)",
      operationId: "changeWorkspaceMemberRole",
      requestBody: {
        content: {
          "application/json": { schema: zodToJsonSchema(workspaceMemberRolePatchSchema) },
        },
      },
    },
  },
  "/api/v1/settings/members/{membershipId}/deactivate": {
    post: { summary: "Deactivate a member", operationId: "deactivateWorkspaceMember" },
  },
  "/api/v1/settings/members/{membershipId}/reactivate": {
    post: { summary: "Reactivate a member", operationId: "reactivateWorkspaceMember" },
  },
  "/api/v1/settings/invites": {
    get: { summary: "List invitations", operationId: "listWorkspaceInvites" },
    post: {
      summary: "Invite a user (returns the raw token once)",
      operationId: "createWorkspaceInvite",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(workspaceInviteCreateSchema) } },
      },
    },
  },
  "/api/v1/settings/invites/{id}/resend": {
    post: { summary: "Rotate an invitation token", operationId: "resendWorkspaceInvite" },
  },
  "/api/v1/settings/invites/{id}": {
    delete: { summary: "Revoke an invitation", operationId: "revokeWorkspaceInvite" },
  },
  "/api/v1/settings/teams": {
    get: { summary: "List teams", operationId: "listWorkspaceTeams" },
    post: {
      summary: "Create a team",
      operationId: "createWorkspaceTeam",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(workspaceTeamCreateSchema) } },
      },
    },
  },
  "/api/v1/settings/teams/{id}": {
    get: { summary: "Get a team with its members", operationId: "getWorkspaceTeam" },
    patch: {
      summary: "Update a team",
      operationId: "updateWorkspaceTeam",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(workspaceTeamPatchSchema) } },
      },
    },
    delete: { summary: "Soft-delete a team", operationId: "deleteWorkspaceTeam" },
  },
  "/api/v1/settings/teams/{id}/members": {
    post: {
      summary: "Add a membership to a team",
      operationId: "addWorkspaceTeamMember",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(workspaceTeamMemberAddSchema) } },
      },
    },
  },
  "/api/v1/settings/teams/{id}/members/{membershipId}": {
    delete: {
      summary: "Remove a membership from a team",
      operationId: "removeWorkspaceTeamMember",
    },
  },
  "/api/v1/settings/audit": {
    get: {
      summary: "Read the audit log (append-only: there is no write endpoint)",
      operationId: "listAuditEvents",
    },
  },
  "/api/v1/settings/audit/{id}": {
    get: { summary: "Read one audit event", operationId: "getAuditEvent" },
  },
  "/api/v1/settings/data-requests": {
    get: { summary: "List GDPR/DPDP data requests", operationId: "listDataRequests" },
    post: {
      summary: "Request an export or deletion (deletion soft-deletes the subject)",
      operationId: "createDataRequest",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(dataRequestCreateSchema) } },
      },
    },
  },
  "/api/v1/settings/data-requests/{id}/export": {
    post: {
      summary: "Assemble the export payload for a pending export request",
      operationId: "fulfilDataExportRequest",
    },
  },
}

export {
  auditListEnvelope,
  dataRequestListEnvelope,
  inviteListEnvelope,
  memberListEnvelope,
  settingsEnvelope,
  teamListEnvelope,
}
