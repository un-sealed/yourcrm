import type { ConversationSource, ConversationTurn } from "./types"

/**
 * Cost bounding for conversation analysis (spec 37 §17/§18, P0).
 *
 * ## The problem
 *
 * A conversation is unbounded. An email thread can run to hundreds of
 * quoted replies; an hour-long call transcript is comfortably 60 000
 * characters. Tokens cost money per call, and a provider will happily
 * accept — and bill for — whatever it is sent until it hits its own
 * context limit and fails, which is the most expensive possible way to
 * find out.
 *
 * So the size of a request is decided HERE, by pure functions, before any
 * provider is reachable. Nothing in this module can send a prompt that did
 * not come through {@link boundConversationText}.
 *
 * ## The cap
 *
 * {@link CONVERSATION_ANALYSIS_MAX_SOURCE_CHARS} = 24 000 characters of
 * conversation text per analysis. At the industry-standard ~4 characters
 * per token that is ≈6 000 prompt tokens, plus a system prompt under 200
 * tokens, plus {@link CONVERSATION_ANALYSIS_MAX_OUTPUT_TOKENS} = 2 000 of
 * completion. One analysis is therefore bounded at roughly 8 200 tokens
 * whatever it is pointed at, and one request may ask for at most the four
 * analysis types, so a single API call is bounded at ≈32 800 tokens.
 *
 * 24 000 characters is about 4 000 words — a 35-minute call or a thread of
 * roughly forty substantial messages. Below that nothing is truncated at
 * all, which is the overwhelming majority of real conversations.
 *
 * ## Head-and-tail, not head-only
 *
 * When a conversation is over the cap the MIDDLE is dropped, keeping 60%
 * from the start and 40% from the end. A conversation's two most
 * informative regions are how it opened (the ask, the context) and how it
 * ended (the decision, the next step); the negotiation in the middle is
 * the compressible part. Dropping the tail instead — the naive
 * `slice(0, cap)` — reliably loses the outcome, which is exactly what a
 * summary, a sentiment read and an action-item list are about.
 *
 * ## Deterministic
 *
 * Same text in, same text out, always: no sampling, no clock, no model in
 * the loop. Two analyses of an unchanged conversation send byte-identical
 * prompts, which is what makes the cost predictable and the tests exact.
 * The cut points snap to a line break when one is nearby, and snapping
 * only ever makes the result SHORTER, so the bound holds unconditionally.
 */

/** Characters of conversation text sent to the provider per analysis. */
export const CONVERSATION_ANALYSIS_MAX_SOURCE_CHARS = 24_000

/**
 * Completion ceiling passed to the provider on every call.
 *
 * 2 000, and the number is empirical rather than tasteful. Against the
 * configured model (`deepseek-v4-flash`) a real four-turn thread needed
 * 978 completion tokens to produce three action items; at 700 the reply
 * was cut off and came back as an EMPTY action-item list — which reads
 * like a confident "nothing to do" on a thread with three obvious
 * commitments in it, and costs full price. Reasoning-style models spend
 * most of this budget before the first visible character, so a cap tuned
 * to the length of the ANSWER is the wrong cap.
 *
 * A too-small output cap is therefore not a saving, it is a silent wrong
 * answer. The cap is set where real answers fit, and
 * `AI_PROVIDER_RESPONSE_TRUNCATED` records every time it is hit anyway —
 * see `runOne` in `service.ts`. Cost stays bounded either way.
 */
export const CONVERSATION_ANALYSIS_MAX_OUTPUT_TOKENS = 2_000

/** Analyses one request may ask for at once (there are four types). */
export const CONVERSATION_ANALYSIS_MAX_TYPES_PER_REQUEST = 4

/** Industry-standard estimate, used only for documentation and display. */
export const CONVERSATION_CHARS_PER_TOKEN = 4

/** Share of the budget kept from the start of the conversation. */
const HEAD_SHARE = 0.6

/** How far a cut point may move to land on a line break. */
const SNAP_WINDOW = 400

/** Longest single turn kept verbatim; longer ones are cut with a marker. */
const MAX_TURN_CHARS = 4_000

const OMISSION_PREFIX = "\n\n[… "
const OMISSION_SUFFIX = " characters omitted from the middle of this conversation …]\n\n"

export type BoundedConversationText = {
  /** What will be sent. Never longer than the cap. */
  text: string
  /** Characters in the full conversation, before bounding. */
  sourceChars: number
  /** Characters actually sent. */
  analysedChars: number
  truncated: boolean
  /** Characters dropped from the middle. Zero when not truncated. */
  omittedChars: number
}

/** Rough token estimate for display. Never used to decide anything. */
export function estimateConversationTokens(chars: number): number {
  return Math.ceil(chars / CONVERSATION_CHARS_PER_TOKEN)
}

/** One turn as the model sees it. Kept short so a cut is meaningful. */
export function formatConversationTurn(turn: ConversationTurn): string {
  const when = turn.at === null || turn.at === "" ? "" : ` (${turn.at})`
  const body =
    turn.text.length > MAX_TURN_CHARS
      ? `${turn.text.slice(0, MAX_TURN_CHARS)}…[turn truncated]`
      : turn.text
  return `${turn.speaker}${when}: ${body}`
}

/**
 * The conversation as one deterministic block of text, oldest turn first.
 * Pure: no store, no clock, no provider.
 */
export function conversationSourceToText(source: ConversationSource): string {
  return source.turns
    .filter((turn) => turn.text.trim() !== "")
    .map(formatConversationTurn)
    .join("\n\n")
}

/** Last line break at or before `index`, or `index` when none is close. */
function snapBack(text: string, index: number): number {
  const from = Math.max(0, index - SNAP_WINDOW)
  const found = text.lastIndexOf("\n", index)
  return found >= from ? found : index
}

/** First line break at or after `index`, or `index` when none is close. */
function snapForward(text: string, index: number): number {
  const found = text.indexOf("\n", index)
  return found !== -1 && found <= index + SNAP_WINDOW ? found + 1 : index
}

/**
 * Bound a conversation to `maxChars`, keeping the opening and the ending.
 *
 * Guarantees, all asserted in `bounds.test.ts`:
 *  - `analysedChars <= maxChars`, for every input, always;
 *  - identical input ⇒ identical output (deterministic);
 *  - `truncated` is true exactly when something was dropped, and
 *    `omittedChars` says how much.
 */
export function boundConversationText(
  text: string,
  maxChars: number = CONVERSATION_ANALYSIS_MAX_SOURCE_CHARS,
): BoundedConversationText {
  const cap = Math.max(1, Math.floor(maxChars))
  const sourceChars = text.length
  if (sourceChars <= cap) {
    return { text, sourceChars, analysedChars: sourceChars, truncated: false, omittedChars: 0 }
  }

  const marker = (omitted: number): string =>
    `${OMISSION_PREFIX}${String(omitted)}${OMISSION_SUFFIX}`
  // Budget is computed against the LONGEST possible marker (the omission
  // count can only shrink once the snaps are applied), so the final string
  // can never exceed the cap.
  const markerLength = marker(sourceChars).length
  if (markerLength >= cap) {
    // Pathologically small cap: no room for a marker, so take a head slice.
    const head = text.slice(0, cap)
    return {
      text: head,
      sourceChars,
      analysedChars: head.length,
      truncated: true,
      omittedChars: sourceChars - head.length,
    }
  }

  const budget = cap - markerLength
  const headBudget = Math.ceil(budget * HEAD_SHARE)
  const tailBudget = budget - headBudget

  const headEnd = snapBack(text, headBudget)
  const tailStart = snapForward(text, sourceChars - tailBudget)
  const head = text.slice(0, headEnd)
  const tail = tailStart >= sourceChars ? "" : text.slice(tailStart)
  const omittedChars = sourceChars - head.length - tail.length
  const bounded = `${head}${marker(omittedChars)}${tail}`

  return {
    text: bounded,
    sourceChars,
    analysedChars: bounded.length,
    truncated: true,
    omittedChars,
  }
}

/** Bound a whole source in one step — what the service calls. */
export function boundConversationSource(
  source: ConversationSource,
  maxChars: number = CONVERSATION_ANALYSIS_MAX_SOURCE_CHARS,
): BoundedConversationText {
  return boundConversationText(conversationSourceToText(source), maxChars)
}
