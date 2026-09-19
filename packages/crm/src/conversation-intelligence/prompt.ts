import type { AiMessage } from "@yourcrm/ai"
import type { BoundedConversationText } from "./bounds"
import type { ConversationActionItem, ConversationAnalysisType, ConversationSource } from "./types"

/**
 * Prompts and output parsing for the four P0 analyses (spec 37 §3).
 *
 * Pure functions: a prompt is a deterministic function of the bounded
 * conversation text, and an output is a deterministic function of the
 * model's reply. No store, no clock, no network — so the shape of what we
 * ask for and the shape of what we keep are both unit-testable without a
 * provider.
 *
 * ## Why parsing is lenient
 *
 * The prompts ask for JSON and the parser tries JSON first, but a model
 * that answers in prose must not turn into a failed analysis and a wasted
 * call that the user pays for twice. Every type therefore has a prose
 * fallback that still produces a well-formed record. The alternative —
 * strict JSON or bust — makes the feature's reliability a function of the
 * model's mood.
 *
 * ## Why everything is capped again here
 *
 * `bounds.ts` caps what goes IN. These caps bound what comes BACK: a
 * model that decides to emit two thousand "action items" must not write
 * two thousand rows into a jsonb column. Input bounding and output
 * bounding are separate problems and both are this module's to solve.
 */

const SUMMARY_MAX_CHARS = 4_000
const RATIONALE_MAX_CHARS = 1_500
const ITEM_MAX_CHARS = 300
const MAX_HIGHLIGHTS = 12
const MAX_ACTION_ITEMS = 25
const MAX_TOPICS = 20

/**
 * The caveat spec 37 §3 requires on every sentiment signal. Stored with
 * the row, not added by the UI, so an export or an API consumer carries
 * it too.
 */
export const CONVERSATION_SENTIMENT_CAVEAT =
  "Sentiment is a model's impression of the text only. It does not account for tone of voice, context outside this conversation, sarcasm or cultural norms, and should never be the sole basis for a decision about a person."

export const CONVERSATION_SENTIMENT_LABELS = ["positive", "neutral", "negative", "mixed"] as const

export type ConversationSentimentLabel = (typeof CONVERSATION_SENTIMENT_LABELS)[number]

export type ConversationSummaryOutput = {
  kind: "summary"
  summary: string
  highlights: string[]
}

export type ConversationSentimentOutput = {
  kind: "sentiment"
  label: ConversationSentimentLabel
  /** -1 … 1, or null when the model did not give a usable number. */
  score: number | null
  rationale: string
  caveat: string
}

export type ConversationActionItemsOutput = {
  kind: "action_items"
  items: ConversationActionItem[]
}

export type ConversationKeyTopicsOutput = {
  kind: "key_topics"
  topics: { topic: string; mentions: number | null }[]
}

export type ConversationAnalysisOutput =
  | ConversationSummaryOutput
  | ConversationSentimentOutput
  | ConversationActionItemsOutput
  | ConversationKeyTopicsOutput

/* ------------------------------- prompts ------------------------------- */

const INSTRUCTIONS: Record<ConversationAnalysisType, string> = {
  summary:
    'Summarise this conversation. Reply with JSON only: {"summary": "<one paragraph, at most 120 words>", "highlights": ["<short factual point>", ...]}. Use at most 8 highlights. Report only what the conversation says; never invent a detail.',
  sentiment:
    'Judge the overall sentiment of this conversation from the customer\'s side. Reply with JSON only: {"label": "positive"|"neutral"|"negative"|"mixed", "score": <number between -1 and 1>, "rationale": "<at most 60 words, quoting nothing verbatim>"}. If the text does not support a confident read, answer "neutral" and say so in the rationale.',
  action_items:
    'Extract the concrete things somebody committed to do next. Reply with JSON only: {"items": [{"title": "<imperative, at most 15 words>", "owner": "<name as written in the conversation, or null>", "dueDate": "<YYYY-MM-DD, or null>"}, ...]}. Include only commitments that were actually made. An empty list is a correct answer.',
  key_topics:
    'List the subjects this conversation is about. Reply with JSON only: {"topics": [{"topic": "<2-4 words>", "mentions": <integer>}, ...]}. At most 10 topics, most significant first.',
}

/**
 * The system prompt. Three jobs: say what the model is, forbid invention,
 * and forbid the two things that make an AI reading of a private
 * conversation dangerous — guessing, and taking action.
 */
export function buildConversationAnalysisSystemPrompt(
  analysisType: ConversationAnalysisType,
): string {
  return [
    "You are an analyst inside a CRM. You are given one customer conversation and you describe what is in it.",
    "Ground every statement in the text you were given. If something is not in the conversation, say nothing about it — never guess a name, a number, a date or an intention.",
    "The conversation may have had its middle removed to fit a size limit. When it has, say so rather than inferring what was cut.",
    "You cannot take actions. You do not create tasks, send messages or change records; you only describe. A person decides what to do with your answer.",
    "Answer with the requested JSON object and nothing else — no prose before it, no code fences.",
    INSTRUCTIONS[analysisType],
  ].join("\n")
}

/** Non-identifying header so the model knows what it is looking at. */
function describeSubject(source: ConversationSource, bounded: BoundedConversationText): string {
  const lines = [
    `Channel: ${source.subjectType}`,
    `Title: ${source.title}`,
    `Participants: ${source.participants.length > 0 ? source.participants.join(", ") : "unknown"}`,
    `Turns: ${String(source.turns.length)}`,
  ]
  if (source.occurredAt !== null && source.occurredAt !== "") {
    lines.push(`Started: ${source.occurredAt}`)
  }
  if (bounded.truncated) {
    lines.push(
      `Note: ${String(bounded.omittedChars)} characters were removed from the middle of this conversation to fit a size limit. The opening and the ending are intact.`,
    )
  }
  return lines.join("\n")
}

/**
 * The messages for one analysis. Exactly two: a system prompt and the
 * bounded conversation. No history, no tools — an analysis is a pure
 * function of one conversation, so there is nothing for a tool to fetch
 * and nothing a previous turn could contribute.
 */
export function buildConversationAnalysisMessages(input: {
  analysisType: ConversationAnalysisType
  source: ConversationSource
  bounded: BoundedConversationText
}): AiMessage[] {
  return [
    { role: "system", content: buildConversationAnalysisSystemPrompt(input.analysisType) },
    {
      role: "user",
      content: `${describeSubject(input.source, input.bounded)}\n\n--- conversation ---\n${input.bounded.text}\n--- end of conversation ---`,
    },
  ]
}

/* -------------------------------- parsing ------------------------------- */

function clamp(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Best-effort JSON object out of a model reply: strips code fences, then
 * takes the outermost `{…}`. Returns null when there is nothing to parse,
 * which is the signal to use the prose fallback.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const withoutFences = text.replace(/```(?:json)?/gi, "").trim()
  const start = withoutFences.indexOf("{")
  const end = withoutFences.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try {
    return asRecord(JSON.parse(withoutFences.slice(start, end + 1)))
  } catch {
    return null
  }
}

/** Bullet/numbered lines of a prose reply, for the fallbacks. */
export function conversationBulletLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((line) => line !== "" && !line.endsWith(":"))
}

function normalizeSentimentLabel(value: unknown): ConversationSentimentLabel | null {
  const text = asString(value)?.toLowerCase()
  if (text === undefined || text === null) return null
  return (
    CONVERSATION_SENTIMENT_LABELS.find((label) => text === label || text.includes(label)) ?? null
  )
}

function parseSummary(text: string): ConversationSummaryOutput {
  const json = extractJsonObject(text)
  const summary = json === null ? null : asString(json.summary)
  const highlights = (json === null ? [] : asArray(json.highlights))
    .map((entry) => asString(entry) ?? asString(asRecord(entry)?.text))
    .filter((entry): entry is string => entry !== null)
    .slice(0, MAX_HIGHLIGHTS)
    .map((entry) => clamp(entry, ITEM_MAX_CHARS))
  if (summary !== null)
    return { kind: "summary", summary: clamp(summary, SUMMARY_MAX_CHARS), highlights }
  // Prose fallback: the whole reply is the summary.
  return { kind: "summary", summary: clamp(text, SUMMARY_MAX_CHARS), highlights }
}

function parseSentiment(text: string): ConversationSentimentOutput {
  const json = extractJsonObject(text)
  const label =
    (json === null ? null : normalizeSentimentLabel(json.label)) ??
    normalizeSentimentLabel(text) ??
    "neutral"
  const rawScore = json === null ? null : asNumber(json.score)
  const score = rawScore === null ? null : Math.max(-1, Math.min(1, rawScore))
  const rationale = (json === null ? null : asString(json.rationale)) ?? text
  return {
    kind: "sentiment",
    label,
    score,
    rationale: clamp(rationale, RATIONALE_MAX_CHARS),
    caveat: CONVERSATION_SENTIMENT_CAVEAT,
  }
}

function toActionItem(entry: unknown): ConversationActionItem | null {
  const direct = asString(entry)
  if (direct !== null) return { title: clamp(direct, ITEM_MAX_CHARS), owner: null, dueDate: null }
  const record = asRecord(entry)
  if (record === null) return null
  const title = asString(record.title) ?? asString(record.item) ?? asString(record.action)
  if (title === null) return null
  const owner = asString(record.owner) ?? asString(record.assignee)
  const dueDate = asString(record.dueDate) ?? asString(record.due_date) ?? asString(record.due)
  return {
    title: clamp(title, ITEM_MAX_CHARS),
    owner: owner === null ? null : clamp(owner, ITEM_MAX_CHARS),
    dueDate: dueDate === null ? null : clamp(dueDate, 32),
  }
}

function parseActionItems(text: string): ConversationActionItemsOutput {
  const json = extractJsonObject(text)
  const raw = json === null ? [] : asArray(json.items ?? json.actionItems ?? json.action_items)
  const items = raw
    .map(toActionItem)
    .filter((item): item is ConversationActionItem => item !== null)
    .slice(0, MAX_ACTION_ITEMS)
  if (items.length > 0 || json !== null) return { kind: "action_items", items }
  // Prose fallback: bullet lines are commitments.
  return {
    kind: "action_items",
    items: conversationBulletLines(text)
      .slice(0, MAX_ACTION_ITEMS)
      .map((title) => ({ title: clamp(title, ITEM_MAX_CHARS), owner: null, dueDate: null })),
  }
}

function parseKeyTopics(text: string): ConversationKeyTopicsOutput {
  const json = extractJsonObject(text)
  const raw = json === null ? [] : asArray(json.topics ?? json.keyTopics ?? json.key_topics)
  const topics = raw
    .map((entry) => {
      const direct = asString(entry)
      if (direct !== null) return { topic: clamp(direct, ITEM_MAX_CHARS), mentions: null }
      const record = asRecord(entry)
      const topic = record === null ? null : (asString(record.topic) ?? asString(record.name))
      if (topic === null) return null
      const mentions = record === null ? null : asNumber(record.mentions)
      return {
        topic: clamp(topic, ITEM_MAX_CHARS),
        mentions: mentions === null ? null : Math.max(0, Math.round(mentions)),
      }
    })
    .filter((entry): entry is { topic: string; mentions: number | null } => entry !== null)
    .slice(0, MAX_TOPICS)
  if (topics.length > 0 || json !== null) return { kind: "key_topics", topics }
  return {
    kind: "key_topics",
    topics: conversationBulletLines(text)
      .slice(0, MAX_TOPICS)
      .map((topic) => ({ topic: clamp(topic, ITEM_MAX_CHARS), mentions: null })),
  }
}

/** Model reply -> the structured record stored in `output`. Total. */
export function parseConversationAnalysisOutput(
  analysisType: ConversationAnalysisType,
  text: string,
): ConversationAnalysisOutput {
  if (analysisType === "summary") return parseSummary(text)
  if (analysisType === "sentiment") return parseSentiment(text)
  if (analysisType === "action_items") return parseActionItems(text)
  return parseKeyTopics(text)
}

/**
 * True when an output carries no actual finding.
 *
 * Needed because "the model found nothing" and "the model was cut off
 * mid-answer" produce the SAME empty shape, and only the second is a
 * failure. The service pairs this with the provider's `finishReason` to
 * tell them apart — see `runOne` in `service.ts`.
 */
export function isEmptyConversationAnalysisOutput(output: ConversationAnalysisOutput): boolean {
  if (output.kind === "summary") return output.summary.trim() === ""
  if (output.kind === "sentiment") return output.rationale.trim() === ""
  if (output.kind === "action_items") return output.items.length === 0
  return output.topics.length === 0
}

/**
 * The action items inside a stored `output`, or an empty list.
 *
 * Used by `proposeConversationActionItem`, which is the ONLY path from an
 * extracted item to a CRM record — and it proposes, it does not write.
 */
export function conversationActionItemsOf(output: unknown): ConversationActionItem[] {
  const record = asRecord(output)
  if (record === null || record.kind !== "action_items") return []
  return asArray(record.items)
    .map(toActionItem)
    .filter((item): item is ConversationActionItem => item !== null)
}
