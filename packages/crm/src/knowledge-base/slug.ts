import { KbValidationError } from "./errors"

/**
 * Article/category slug safety — reuses the discipline in
 * `packages/crm/src/custom-objects/naming.ts` rather than inventing a looser
 * one: a slug is user-influenced and ends up in URLs (today: API response
 * bodies and, per spec 22, a future public help-centre route), so it is
 * matched against a strict allowlist and rejected outright when it does not
 * fit. Rejecting beats rewriting — a silently rewritten slug would change
 * which article a link addresses.
 *
 * Unlike a custom-object slug, a KB slug does not shadow an API path segment
 * (routes address articles by id — spec 22 §2), so only two reserved-word
 * classes apply here: none, plus the JavaScript/JSON hazards also excluded
 * by `naming.ts`.
 */

/** Lowercase, starts with a letter, single `-`/`_` separators, 2-160 chars. */
export const KB_SLUG_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/

/** Names that are hazardous as JavaScript property names or JSON keys. */
const UNSAFE_WORDS: readonly string[] = [
  "__proto__",
  "constructor",
  "prototype",
  "tostring",
  "valueof",
  "hasownproperty",
]

/**
 * Validate a KB slug (article or category). Lowercases and trims first (so
 * `  Getting Started ` and `getting-started` normalize the same way before
 * the regex runs), then refuses anything outside the allowlist or on the
 * reserved list. Never mutates beyond case/whitespace.
 */
export function parseKbSlug(value: string): string {
  const slug = value.trim().toLowerCase()
  if (slug.length < 2 || slug.length > 160) {
    throw new KbValidationError("slug must be between 2 and 160 characters")
  }
  if (!KB_SLUG_RE.test(slug)) {
    throw new KbValidationError(
      "slug must be lowercase letters, digits and single - or _ separators, starting with a letter",
    )
  }
  if (UNSAFE_WORDS.includes(slug)) {
    throw new KbValidationError(`slug "${slug}" is reserved`)
  }
  return slug
}

/** True when the slug is safe to use — for UI hints, never as the gate. */
export function isValidKbSlug(value: string): boolean {
  try {
    parseKbSlug(value)
    return true
  } catch {
    return false
  }
}
