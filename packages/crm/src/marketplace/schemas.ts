import { PERMISSION_ACTIONS } from "@yourcrm/permissions"
import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"

/**
 * Marketplace / Plugin SDK zod schemas (spec 49-marketplace-sdk, P0).
 *
 * The manifest is the developer-facing contract — see
 * `packages/integrations/MARKETPLACE.md` for the authoring guide. Services
 * validate every manifest with `appManifestSchema` before it is persisted;
 * nothing downstream (repository, route, UI) ever trusts an unvalidated one.
 */

const APP_ID_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/
const APP_VERSION_RE = /^\d+\.\d+\.\d+$/

/**
 * Scope string, `"<object>:<action>"` — e.g. `"person:read"`,
 * `"deal:update"`. `action` is restricted to `PERMISSION_ACTIONS`; `object`
 * is any lowercase snake_case identifier (not a closed enum: the manifest
 * layer must not need updating every time a new CRM object ships).
 */
const SCOPE_STRING_RE = new RegExp(`^[a-z][a-z0-9_]*:(${PERMISSION_ACTIONS.join("|")})$`)

export const appScopeStringSchema = z
  .string()
  .trim()
  .regex(SCOPE_STRING_RE, 'scope must be "<object>:<action>", e.g. "person:read"')

export type AppScopeString = z.infer<typeof appScopeStringSchema>

/** `"person:read"` -> `{ object: "person", action: "read" }`. */
export function parseAppScope(scope: AppScopeString): { object: string; action: string } {
  const separatorIndex = scope.indexOf(":")
  return { object: scope.slice(0, separatorIndex), action: scope.slice(separatorIndex + 1) }
}

/** `{ object: "person", action: "read" }` -> `"person:read"`. */
export function formatAppScope(scope: { object: string; action: string }): AppScopeString {
  return `${scope.object}:${scope.action}`
}

/**
 * Known, meaningful slots for a manifest's UI extension points. P0 renders
 * none of these — the platform declares and stores where the app WANTS a
 * slot, so the consent screen can show it plainly. Mounting them is future
 * work (see the "NOT BUILT IN P0" note in `service.ts`).
 */
export const APP_UI_EXTENSION_POINTS = [
  "record.detail.tab",
  "record.detail.panel",
  "record.action",
  "nav.item",
  "dashboard.widget",
] as const

export type AppUiExtensionPoint = (typeof APP_UI_EXTENSION_POINTS)[number]

const appWebhookDeclarationSchema = z.object({
  /** `<domain>.<entity>.<verb>`, matching the `@yourcrm/events` envelope convention. */
  event: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, {
      message: 'event must look like "domain.entity.verb"',
    }),
  description: z.string().trim().max(500).nullish(),
})

const appUiExtensionDeclarationSchema = z.object({
  location: z.enum(APP_UI_EXTENSION_POINTS),
  label: z.string().trim().min(1).max(120),
})

/**
 * The manifest. This is the entire surface a P0 app declares: identity,
 * requested scopes, declared (not dispatched) webhooks, declared (not
 * mounted) UI extension points. No entry point, no bundle URL, no code.
 */
export const appManifestSchema = z.object({
  id: z.string().trim().regex(APP_ID_RE, "id must match ^[a-z0-9][a-z0-9_-]{1,62}$"),
  name: z.string().trim().min(1).max(255),
  version: z.string().trim().regex(APP_VERSION_RE, "version must be semver, e.g. 1.0.0"),
  publisher: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).nullish(),
  scopes: z.array(appScopeStringSchema).min(1, "at least one scope is required").max(50),
  webhooks: z.array(appWebhookDeclarationSchema).max(20).default([]),
  uiExtensionPoints: z.array(appUiExtensionDeclarationSchema).max(20).default([]),
  docsUrl: z.string().trim().url().max(2048).nullish(),
})

export type AppManifestInput = z.infer<typeof appManifestSchema>

export const registerAppSchema = z.object({
  manifest: appManifestSchema,
  status: z.enum(["draft", "published"]).default("published"),
})

export type RegisterAppInput = z.infer<typeof registerAppSchema>

export const marketplaceAppQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["draft", "published", "deprecated"]).optional(),
})

export type MarketplaceAppQuery = z.infer<typeof marketplaceAppQuerySchema>

export const installAppSchema = z.object({}).default({})

export type InstallAppInput = z.infer<typeof installAppSchema>

/* ---------------------------------- DTOs --------------------------------- */

export const marketplaceAppSchema = z.object({
  id: z.string(),
  appKey: z.string(),
  name: z.string(),
  version: z.string(),
  publisher: z.string(),
  description: z.string().nullable().optional(),
  status: z.string(),
  manifest: z.record(z.string(), z.unknown()),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type MarketplaceAppDto = z.infer<typeof marketplaceAppSchema>

export const appScopeGrantSchema = z.object({
  id: z.string(),
  installationId: z.string(),
  object: z.string(),
  action: z.string(),
})

export type AppScopeGrantDto = z.infer<typeof appScopeGrantSchema>

export const appInstallationSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  appId: z.string(),
  appVersion: z.string(),
  status: z.string(),
  installedBy: z.string().nullable().optional(),
  installedAt: z.unknown(),
  uninstalledAt: z.unknown().nullable().optional(),
})

export type AppInstallationDto = z.infer<typeof appInstallationSchema>
