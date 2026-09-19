import { createHash } from "node:crypto"

/**
 * Email threading (spec 14-email, P0) — the technical core of the module.
 *
 * Getting this wrong fragments conversations, so the rules are written once,
 * here, as pure functions plus one small async resolver over a lookup port.
 * Nothing in this file touches a database, a provider or a clock.
 *
 * THE ALGORITHM, IN ORDER
 * -----------------------
 * 1. REFERENCE CHAIN (RFC 5322 §3.6.4). Build the ancestor list from
 *    `In-Reply-To` followed by `References` **reversed**, i.e. nearest
 *    ancestor first, and take the thread of the first ancestor already
 *    stored in this workspace. This is the authoritative path: a client that
 *    sets these headers tells us exactly which conversation it is in, even
 *    when the subject was rewritten ("Re: Re: Fwd: budget" -> "budget v2").
 *    Nearest-first matters when a reply quotes ancestors from two threads
 *    (forward-then-reply): the immediate parent wins, not a distant root.
 *
 * 2. SUBJECT + PARTICIPANT SET. Only when step 1 produced no hit — plenty of
 *    mailers still drop the headers. A thread matches when BOTH its
 *    normalised subject (reply/forward prefixes stripped, whitespace
 *    collapsed, lower-cased) AND its participant key (sha256 of the sorted,
 *    de-duplicated address set) match. Subject alone is not enough: two
 *    people sending "Invoice" to different customers must not merge. The
 *    caller may also bound the match to threads active since a cutoff, so a
 *    year-old "Invoice" thread does not swallow a fresh one.
 *
 * 3. NEW THREAD. No match: the message starts a conversation, and the
 *    normalised subject + participant key computed here are FROZEN onto the
 *    new thread row. Freezing them is what keeps step 2 stable — if every
 *    reply re-keyed the thread from its own (growing) recipient list, the
 *    next message would fail to match the thread it belongs to.
 *
 * An empty normalised subject or an empty participant set disables step 2
 * entirely: without both keys the fallback would glue every subject-less
 * message in the workspace into one thread.
 */

/** Values the resolver understands as "no usable header". */
const EMPTY_HEADER_VALUES = new Set(["", "<>", "nil", "null", "undefined"])

/**
 * Canonical form of an RFC 5322 message identifier: angle brackets stripped,
 * trimmed, lower-cased. Returns null when nothing usable is left.
 *
 * SINGLE SOURCE OF TRUTH. `email_messages.message_id`, `in_reply_to` and
 * `reference_ids` are stored in exactly this form, and
 * `email_messages_message_id_uidx` compares raw column values, so the
 * repository layer deliberately does NOT re-implement this — see the header
 * of `packages/database/src/repositories/email-repository.ts`.
 *
 * Message-IDs are case-sensitive in the RFC but are compared
 * case-insensitively in practice (and mailers do rewrite the domain part's
 * case), so lower-casing costs nothing and prevents a whole class of
 * fragmentation.
 */
export function normalizeEmailMessageId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  let out = value.trim()
  while (out.startsWith("<")) out = out.slice(1).trim()
  while (out.endsWith(">")) out = out.slice(0, -1).trim()
  out = out.replace(/\s+/g, "").toLowerCase()
  if (EMPTY_HEADER_VALUES.has(out)) return null
  return out.length > 998 ? out.slice(0, 998) : out
}

/**
 * Parse a `References` header into normalised ids, oldest first, deduped.
 * Accepts the raw header string (whitespace and/or comma separated, as
 * mailers vary) or an already-split array from a structured provider payload.
 */
export function parseEmailReferenceChain(
  references: string | readonly string[] | null | undefined,
): string[] {
  if (references === null || references === undefined) return []
  const parts =
    typeof references === "string"
      ? (references.match(/<[^>]*>/g) ?? references.split(/[\s,]+/))
      : references
  const out: string[] = []
  for (const part of parts) {
    const normalized = normalizeEmailMessageId(part)
    if (normalized !== null && !out.includes(normalized)) out.push(normalized)
  }
  return out
}

/**
 * Reply/forward prefixes, in the languages a self-hosted CRM realistically
 * meets. `\[\d+\]` covers Outlook's "Re[2]:" counter form.
 */
const SUBJECT_PREFIX_RE =
  /^(?:re|aw|antw|antwort|fw|fwd|wg|sv|vs|vb|res|enc|rif|tr|odp)\s*(?:\[\d+\])?\s*:\s*/i

/**
 * Normalised subject used by the fallback match: reply/forward prefixes
 * stripped repeatedly, whitespace collapsed, lower-cased. An all-prefix
 * subject ("Re:") normalises to "" — which disables the fallback rather than
 * matching every other prefix-only subject.
 */
export function normalizeEmailSubject(subject: string | null | undefined): string {
  let out = (subject ?? "").replace(/\s+/g, " ").trim()
  // Bounded: a pathological "Re: Re: Re: …" subject must not spin.
  for (let i = 0; i < 12; i += 1) {
    const next = out.replace(SUBJECT_PREFIX_RE, "").trim()
    if (next === out) break
    out = next
  }
  return out.toLowerCase()
}

/** Trimmed, lower-cased address, or null when it is not one. */
export function normalizeEmailAddress(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim().toLowerCase()
  if (trimmed.length === 0 || !trimmed.includes("@")) return null
  return trimmed
}

/**
 * Stable key for a set of addresses: sorted, de-duplicated, hashed.
 *
 * A digest rather than the joined list because it is fixed-width (indexable
 * as `varchar(64)`, see `email_threads.participant_key`) and because the
 * address list itself is PII that has no business being duplicated into an
 * index. Order and repetition are irrelevant to identity, so both are
 * removed before hashing. An empty set returns "" — the sentinel that
 * disables subject fallback.
 */
export function emailParticipantKey(addresses: readonly (string | null | undefined)[]): string {
  const unique = new Set<string>()
  for (const address of addresses) {
    const normalized = normalizeEmailAddress(address)
    if (normalized !== null) unique.add(normalized)
  }
  if (unique.size === 0) return ""
  const canonical = [...unique].sort().join("\n")
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

/**
 * Ancestor ids to probe, NEAREST FIRST: `In-Reply-To`, then `References`
 * reversed. Deduplicated, preserving that priority order.
 */
export function emailAncestorIds(input: {
  inReplyTo?: string | null
  references?: string | readonly string[] | null
}): string[] {
  const ordered: string[] = []
  const push = (value: string | null) => {
    if (value !== null && !ordered.includes(value)) ordered.push(value)
  }
  push(normalizeEmailMessageId(input.inReplyTo))
  const chain = parseEmailReferenceChain(input.references)
  for (let i = chain.length - 1; i >= 0; i -= 1) push(chain[i] ?? null)
  return ordered
}

/** What the resolver was given about the message being placed. */
export type EmailThreadResolutionInput = {
  workspaceId: string
  subject?: string | null
  inReplyTo?: string | null
  references?: string | readonly string[] | null
  /** Every address on the message: from, to, cc, bcc, reply-to. */
  addresses: readonly (string | null | undefined)[]
  /** Only match threads active since this instant. Null disables the bound. */
  activeSince?: Date | null
}

/** One stored message that matched an ancestor id. */
export type EmailAncestorMatchRecord = {
  messageId: string
  threadId: string
}

/**
 * The two reads threading needs. `EmailThreadStore` extends this, and the
 * database repository satisfies it — but the resolver only ever sees these
 * two methods, which is what makes it trivial to unit-test.
 */
export type EmailThreadLookupPort = {
  /** Which threads already contain any of these normalised Message-IDs? */
  findThreadIdsByMessageIds(
    workspaceId: string,
    messageIds: readonly string[],
  ): Promise<EmailAncestorMatchRecord[]>
  /** Thread whose frozen subject+participant keys match, if any. */
  findThreadByMatch(
    workspaceId: string,
    match: { normalizedSubject: string; participantKey: string; activeSince?: Date | null },
  ): Promise<{ id: string } | null>
}

/**
 * Where a message belongs. `normalizedSubject`/`participantKey` are returned
 * on every branch: the caller freezes them onto a new thread, and callers
 * that want to explain a match can log the reason.
 */
export type EmailThreadResolution = {
  threadId: string | null
  reason: "reference" | "subject" | "new"
  normalizedSubject: string
  participantKey: string
  /** The ancestor id that decided a `reference` match, for audit/debug. */
  matchedAncestorId: string | null
}

/**
 * Resolve the thread for a message. `threadId === null` means "create a new
 * thread with the returned keys" — the resolver never writes.
 */
export async function resolveEmailThread(
  lookup: EmailThreadLookupPort,
  input: EmailThreadResolutionInput,
): Promise<EmailThreadResolution> {
  const normalizedSubject = normalizeEmailSubject(input.subject)
  const participantKey = emailParticipantKey(input.addresses)

  // 1. Reference chain, nearest ancestor first.
  const ancestors = emailAncestorIds(input)
  if (ancestors.length > 0) {
    const matches = await lookup.findThreadIdsByMessageIds(input.workspaceId, ancestors)
    if (matches.length > 0) {
      const byMessageId = new Map(matches.map((match) => [match.messageId, match.threadId]))
      for (const ancestorId of ancestors) {
        const threadId = byMessageId.get(ancestorId)
        if (threadId !== undefined) {
          return {
            threadId,
            reason: "reference",
            normalizedSubject,
            participantKey,
            matchedAncestorId: ancestorId,
          }
        }
      }
    }
  }

  // 2. Subject + participant set. Both keys required — see the header.
  if (normalizedSubject.length > 0 && participantKey.length > 0) {
    const found = await lookup.findThreadByMatch(input.workspaceId, {
      normalizedSubject,
      participantKey,
      activeSince: input.activeSince ?? null,
    })
    if (found) {
      return {
        threadId: found.id,
        reason: "subject",
        normalizedSubject,
        participantKey,
        matchedAncestorId: null,
      }
    }
  }

  // 3. New conversation.
  return {
    threadId: null,
    reason: "new",
    normalizedSubject,
    participantKey,
    matchedAncestorId: null,
  }
}
