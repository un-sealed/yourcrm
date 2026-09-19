import { CustomObjectValidationError } from "./errors"

/**
 * Slug and field-key safety — the injection surface of a metadata engine.
 *
 * Both values are authored by users and both escape their row:
 *  - an object slug becomes a path segment (`/api/v1/custom-objects/:slug`)
 *    and the join key in `custom_field_definitions.object_type`;
 *  - a field key becomes a property name inside the record's jsonb payload
 *    and, from there, a property name on a JavaScript object.
 *
 * So neither is sanitized — both are matched against a strict allowlist and
 * rejected outright when they do not fit. Rejecting beats rewriting: a
 * silently rewritten slug changes which object a request addresses.
 *
 * Three classes of reserved word are refused:
 *  1. built-in object types — a custom object called `person` would hijack
 *     every built-in field definition, because fields of built-in and of
 *     custom objects share one table keyed by `object_type`;
 *  2. routing words that would shadow an API path segment;
 *  3. JavaScript/JSON hazards (`__proto__`, `constructor`, `prototype`) —
 *     prototype pollution the moment a stored payload is spread.
 */

/** Lowercase, starts with a letter, single `-`/`_` separators, 2-64 chars. */
export const CUSTOM_OBJECT_SLUG_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/

/** Lowercase snake_case, starts with a letter — mirrors the column contract. */
export const CUSTOM_OBJECT_FIELD_KEY_RE = /^[a-z][a-z0-9_]*$/

/** Built-in `object_type` values custom objects must never shadow. */
export const CUSTOM_OBJECT_BUILT_IN_TYPES: readonly string[] = [
  "person",
  "people",
  "company",
  "companies",
  "lead",
  "leads",
  "deal",
  "deals",
  "pipeline",
  "pipelines",
  "pipeline-stage",
  "activity",
  "activities",
  "task",
  "tasks",
  "note",
  "notes",
  "file",
  "files",
  "tag",
  "tags",
  "product",
  "products",
  "quote",
  "quotes",
  "invoice",
  "invoices",
  "payment",
  "payments",
  "form",
  "forms",
  "report",
  "reports",
  "dashboard",
  "dashboards",
  "calendar",
  "user",
  "users",
  "team",
  "teams",
  "workspace",
  "workspaces",
  "relationship",
  "relationships",
  "saved-view",
  "saved-views",
  "audit-event",
  "notification",
  "notifications",
]

/** Path segments a slug must not collide with. */
const ROUTING_WORDS: readonly string[] = [
  "api",
  "v1",
  "admin",
  "settings",
  "auth",
  "login",
  "logout",
  "session",
  "sessions",
  "me",
  "health",
  "search",
  "import",
  "export",
  "custom-object",
  "custom-objects",
  "custom-field",
  "custom-fields",
  "objects",
  "fields",
  "records",
  "definitions",
  "new",
  "edit",
  "restore",
  "trash",
  "ai",
  "mcp",
  "webhook",
  "webhooks",
  "automation",
  "integrations",
]

/** Names that are hazardous as JavaScript property names or JSON keys. */
const UNSAFE_WORDS: readonly string[] = [
  "__proto__",
  "constructor",
  "prototype",
  "tostring",
  "valueof",
  "hasownproperty",
  "null",
  "undefined",
  "true",
  "false",
]

export const CUSTOM_OBJECT_RESERVED_SLUGS: readonly string[] = [
  ...CUSTOM_OBJECT_BUILT_IN_TYPES,
  ...ROUTING_WORDS,
  ...UNSAFE_WORDS,
]

/** Field keys that would shadow a `custom_object_records` column, plus hazards. */
export const CUSTOM_OBJECT_RESERVED_FIELD_KEYS: readonly string[] = [
  "id",
  "workspace_id",
  "workspaceid",
  "object_id",
  "objectid",
  "owner_id",
  "ownerid",
  "display_name",
  "displayname",
  "field_values",
  "fieldvalues",
  "created_at",
  "createdat",
  "updated_at",
  "updatedat",
  "created_by",
  "createdby",
  "updated_by",
  "updatedby",
  "deleted_at",
  "deletedat",
  ...UNSAFE_WORDS,
]

/**
 * Validate an object slug. Lowercases and trims first (so `  Deal-Room `
 * and `deal-room` are the same request), then refuses anything outside the
 * allowlist or on the reserved list. Never mutates beyond case/whitespace.
 */
export function parseCustomObjectSlug(value: string): string {
  const slug = value.trim().toLowerCase()
  if (slug.length < 2 || slug.length > 64) {
    throw new CustomObjectValidationError("slug must be between 2 and 64 characters")
  }
  if (!CUSTOM_OBJECT_SLUG_RE.test(slug)) {
    throw new CustomObjectValidationError(
      "slug must be lowercase letters, digits and single - or _ separators, starting with a letter",
    )
  }
  if (CUSTOM_OBJECT_RESERVED_SLUGS.includes(slug)) {
    throw new CustomObjectValidationError(`slug "${slug}" is reserved`)
  }
  return slug
}

/** Validate a field key against the same allowlist discipline as slugs. */
export function parseCustomObjectFieldKey(value: string): string {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
  if (key.length === 0 || key.length > 128) {
    throw new CustomObjectValidationError("field key must be between 1 and 128 characters")
  }
  if (!CUSTOM_OBJECT_FIELD_KEY_RE.test(key)) {
    throw new CustomObjectValidationError(
      "field key must be lowercase a-z, 0-9 and _, starting with a letter",
    )
  }
  if (CUSTOM_OBJECT_RESERVED_FIELD_KEYS.includes(key)) {
    throw new CustomObjectValidationError(`field key "${key}" is reserved`)
  }
  return key
}

/** True when the slug is safe to use — for UI hints, never as the gate. */
export function isValidCustomObjectSlug(value: string): boolean {
  try {
    parseCustomObjectSlug(value)
    return true
  } catch {
    return false
  }
}
