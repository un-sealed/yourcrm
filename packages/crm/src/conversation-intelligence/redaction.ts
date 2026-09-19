/**
 * Content redaction for conversation intelligence (spec 37 §17, P0).
 *
 * ## The leak this closes
 *
 * `redactIntegrationSecrets` (in `../integrations`) keeps CREDENTIALS out
 * of error strings. This module has the opposite problem: the payload
 * itself is the sensitive thing. A conversation is customer PII — names,
 * phone numbers, prices, medical or legal detail, whatever the customer
 * happened to say — and an upstream error commonly quotes the request
 * that caused it:
 *
 * ```text
 * 400 invalid_request: input too long — "Hi Maria, about your account 4451…"
 * ```
 *
 * Let that reach `ai_runs.error_message`, an audit row or a log line and
 * the conversation has silently been copied into a place with a different
 * retention policy and a different, usually wider, audience. Audit rows in
 * particular are readable by workspace admins who may have no business
 * reading the thread.
 *
 * ## The rule this module follows
 *
 * - Audit rows and events carry METADATA ONLY: subject, analysis type,
 *   model, provider, run id, outcome, token counts. Never prompt text,
 *   never transcript text, never the model's answer. See
 *   `conversationAnalysisAuditPayload` in `service.ts`.
 * - Every error string that could have touched the content goes through
 *   {@link redactConversationContent} before it is stored, returned or
 *   raised.
 * - Nothing in this module logs.
 *
 * ## How the redactor works
 *
 * Substring matching, not pattern matching. Patterns (emails, phone
 * numbers) only catch the shapes somebody thought of; here the source text
 * is known exactly, so any run of it that reappears in a message can be
 * found and removed. Runs shorter than {@link REDACTION_WINDOW} are left
 * alone: at 24 characters the chance of a coincidental match with ordinary
 * error prose is negligible, while any genuine quotation of a conversation
 * is far longer.
 */

/** Shortest run of source text treated as a quotation and removed. */
export const REDACTION_WINDOW = 24

/** What replaces a removed run. */
export const REDACTION_PLACEHOLDER = "[redacted]"

/** Shortest known term matched exactly by {@link redactConversationTerms}. */
export const MIN_TERM_LENGTH = 4

/** Errors are capped before storage: `error_message` is varchar(500). */
export const REDACTED_MESSAGE_MAX_CHARS = 400

/**
 * Remove every run of `contents` that appears in `raw`.
 *
 * Deterministic and allocation-bounded: `raw` is capped first, so the
 * scan is O(cap × content length) in the worst case and cannot be turned
 * into a denial of service by a provider returning a megabyte of prose.
 */
export function redactConversationContent(
  raw: string,
  ...contents: readonly (string | null | undefined)[]
): string {
  let out = raw.slice(0, REDACTED_MESSAGE_MAX_CHARS * 4)
  for (const content of contents) {
    if (typeof content !== "string" || content.length < REDACTION_WINDOW) continue
    out = removeRunsOf(out, content)
  }
  return out.length > REDACTED_MESSAGE_MAX_CHARS
    ? `${out.slice(0, REDACTED_MESSAGE_MAX_CHARS - 1)}…`
    : out
}

/**
 * Remove exact occurrences of known short terms — participant names,
 * conversation titles — which {@link redactConversationContent} leaves
 * alone because they are under the window.
 *
 * This is a DIFFERENT problem and needs a different rule. A 24-character
 * window is the right threshold for "is this a quotation of the body",
 * but "Maria Sanchez" is 13 characters and is exactly the kind of thing
 * that must not reach an audit row. It is safe to match those exactly
 * because the list is known and finite: the participants of this one
 * conversation, not a guess at what a name looks like.
 *
 * Terms shorter than {@link MIN_TERM_LENGTH} are ignored — removing every
 * occurrence of "Al" would shred ordinary error prose for no gain.
 */
export function redactConversationTerms(raw: string, terms: readonly string[]): string {
  let out = raw
  // Longest first, so "Maria Sanchez" goes before "Maria".
  const ordered = [...new Set(terms.filter((term) => term.trim().length >= MIN_TERM_LENGTH))].sort(
    (a, b) => b.length - a.length,
  )
  for (const term of ordered) out = out.split(term.trim()).join(REDACTION_PLACEHOLDER)
  return out
}

/** True when any known term still appears verbatim. */
export function containsConversationTerms(message: string, terms: readonly string[]): boolean {
  return terms.some(
    (term) => term.trim().length >= MIN_TERM_LENGTH && message.includes(term.trim()),
  )
}

function removeRunsOf(raw: string, content: string): string {
  let out = ""
  let i = 0
  while (i < raw.length) {
    if (i + REDACTION_WINDOW > raw.length) {
      out += raw.slice(i)
      break
    }
    if (!content.includes(raw.slice(i, i + REDACTION_WINDOW))) {
      out += raw[i] ?? ""
      i += 1
      continue
    }
    // Greedily extend the matched run so the whole quotation goes, not
    // just its first 24 characters.
    let end = i + REDACTION_WINDOW
    while (end < raw.length && content.includes(raw.slice(i, end + 1))) end += 1
    out += REDACTION_PLACEHOLDER
    i = end
  }
  return out
}

/**
 * True when `message` still shares a run of at least
 * {@link REDACTION_WINDOW} characters with any of `contents`.
 *
 * The test-facing inverse of the redactor, and the assertion the service's
 * own failure path makes before it stores anything.
 */
export function containsConversationContent(
  message: string,
  ...contents: readonly (string | null | undefined)[]
): boolean {
  for (const content of contents) {
    if (typeof content !== "string" || content.length < REDACTION_WINDOW) continue
    for (let i = 0; i + REDACTION_WINDOW <= message.length; i += 1) {
      if (content.includes(message.slice(i, i + REDACTION_WINDOW))) return true
    }
  }
  return false
}
