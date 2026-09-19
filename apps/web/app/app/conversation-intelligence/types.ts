import type { BadgeTone } from "@yourcrm/ui"

/**
 * Wire types and pure view helpers for the conversation-intelligence
 * pages (spec 37, P0). Kept out of `page.tsx` so the formatting rules —
 * and the honesty rules, like always showing the sentiment caveat and
 * always showing what was truncated — are unit-testable without
 * rendering React.
 *
 * NOTE ON NAVIGATION: `components/nav-sections.ts` is shared and is NOT
 * this module's file to edit, so `/app/conversation-intelligence` is not
 * yet in the sidebar. Adding one entry there is the integrator's call.
 */

export const CONVERSATION_ANALYSIS_TYPES = [
  "summary",
  "sentiment",
  "action_items",
  "key_topics",
] as const

export type ConversationAnalysisType = (typeof CONVERSATION_ANALYSIS_TYPES)[number]

export const CONVERSATION_SUBJECT_TYPES = ["email_thread", "whatsapp_conversation", "call"] as const

export type ConversationSubjectType = (typeof CONVERSATION_SUBJECT_TYPES)[number]

export type ConversationAnalysis = {
  id: string
  workspaceId: string
  subjectType: string
  subjectId: string
  analysisType: string
  status: string
  providerId: string | null
  model: string | null
  runId: string | null
  output: unknown
  promptTokens: number
  completionTokens: number
  totalTokens: number
  latencyMs: number
  sourceChars: number
  analysedChars: number
  truncated: boolean
  errorCode: string | null
  createdAt: string
  updatedAt: string
}

export type ConversationTurn = { speaker: string; at: string | null; text: string }

export type ConversationAnalysisSubject = {
  subjectType: string
  subjectId: string
  title: string
  participants: string[]
  occurredAt: string | null
  turns: ConversationTurn[]
  sourceChars: number
  analysedChars: number
  truncated: boolean
}

export type ConversationAnalysisDetail = {
  analysis: ConversationAnalysis
  subject: ConversationAnalysisSubject | null
}

export type ConversationAnalysesResponse = {
  data: ConversationAnalysis[]
  pagination: { nextCursor: string | null; limit: number }
}

export type ConversationActionItem = {
  title: string
  owner: string | null
  dueDate: string | null
}

export type ConversationIntelligenceStatus = {
  providerId: string
  model: string
  maxSourceChars: number
  maxOutputTokens: number
  analysisTypes: string[]
  subjectTypes: string[]
  queued: boolean
}

export type ConversationProposalResponse = {
  request: { id: string; status: string }
  mode: string
  applied: boolean
}

/* -------------------------------- labels -------------------------------- */

export const ANALYSIS_TYPE_LABELS: Record<string, string> = {
  summary: "Summary",
  sentiment: "Sentiment",
  action_items: "Action items",
  key_topics: "Key topics",
}

export const SUBJECT_TYPE_LABELS: Record<string, string> = {
  email_thread: "Email thread",
  whatsapp_conversation: "WhatsApp",
  call: "Call",
}

export function analysisTypeLabel(analysisType: string): string {
  return ANALYSIS_TYPE_LABELS[analysisType] ?? analysisType
}

export function subjectTypeLabel(subjectType: string): string {
  return SUBJECT_TYPE_LABELS[subjectType] ?? subjectType
}

export function analysisStatusTone(status: string): BadgeTone {
  if (status === "succeeded") return "success"
  if (status === "queued") return "info"
  return "destructive"
}

export function sentimentTone(label: string): BadgeTone {
  if (label === "positive") return "success"
  if (label === "negative") return "destructive"
  if (label === "mixed") return "warning"
  return "info"
}

/* ------------------------------ attribution ------------------------------ */

/**
 * The attribution line under every analysis: which model produced it, how
 * many tokens it cost, how long it took. Spec 37 §14 — an AI output the
 * user cannot trace to a model and a run is not reviewable.
 */
export function describeAnalysisAttribution(analysis: ConversationAnalysis): string {
  const parts: string[] = []
  if (analysis.model !== null && analysis.model !== "") parts.push(analysis.model)
  parts.push(`${analysis.totalTokens.toLocaleString("en-GB")} tokens`)
  parts.push(`${analysis.latencyMs.toLocaleString("en-GB")} ms`)
  if (analysis.runId !== null && analysis.runId !== "") {
    parts.push(`run ${analysis.runId.slice(0, 8)}`)
  }
  return parts.join(" · ")
}

/**
 * What the model actually saw. Shown on every analysis, not just the
 * truncated ones: "this is a summary of the whole thread" and "this is a
 * summary of the first and last part of a very long thread" are
 * different claims and the user is entitled to know which one they have.
 */
export function describeAnalysisBounds(analysis: {
  sourceChars: number
  analysedChars: number
  truncated: boolean
}): string {
  const source = analysis.sourceChars.toLocaleString("en-GB")
  if (!analysis.truncated) return `Analysed all ${source} characters`
  const analysed = analysis.analysedChars.toLocaleString("en-GB")
  return `Analysed ${analysed} of ${source} characters — the middle was left out to stay inside the size limit`
}

export function formatConversationTimestamp(value: string | null): string {
  if (value === null || value === "") return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString()
}

/* ---------------------------- output readers ----------------------------- */

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : []
}

export function summaryTextOf(output: unknown): string {
  const parsed = record(output)
  return typeof parsed?.summary === "string" ? parsed.summary : ""
}

export function highlightsOf(output: unknown): string[] {
  return stringsOf(record(output)?.highlights)
}

export type ConversationSentimentView = {
  label: string
  score: number | null
  rationale: string
  /** Always rendered. The product promises a transparent caveat. */
  caveat: string
}

export function sentimentOf(output: unknown): ConversationSentimentView | null {
  const parsed = record(output)
  if (parsed === null || parsed.kind !== "sentiment") return null
  return {
    label: typeof parsed.label === "string" ? parsed.label : "neutral",
    score: typeof parsed.score === "number" ? parsed.score : null,
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    caveat: typeof parsed.caveat === "string" ? parsed.caveat : "",
  }
}

export function actionItemsOf(output: unknown): ConversationActionItem[] {
  const parsed = record(output)
  if (parsed === null || !Array.isArray(parsed.items)) return []
  return parsed.items
    .map((entry) => {
      const item = record(entry)
      const title = typeof item?.title === "string" ? item.title : null
      if (title === null) return null
      return {
        title,
        owner: typeof item?.owner === "string" ? item.owner : null,
        dueDate: typeof item?.dueDate === "string" ? item.dueDate : null,
      }
    })
    .filter((item): item is ConversationActionItem => item !== null)
}

export function topicsOf(output: unknown): { topic: string; mentions: number | null }[] {
  const parsed = record(output)
  if (parsed === null || !Array.isArray(parsed.topics)) return []
  return parsed.topics
    .map((entry) => {
      const item = record(entry)
      const topic = typeof item?.topic === "string" ? item.topic : null
      if (topic === null) return null
      return { topic, mentions: typeof item?.mentions === "number" ? item.mentions : null }
    })
    .filter((item): item is { topic: string; mentions: number | null } => item !== null)
}

/** One line describing an analysis in the list. */
export function describeAnalysisRow(analysis: ConversationAnalysis): string {
  if (analysis.status === "queued") return "Waiting to run"
  if (analysis.status === "failed") return analysis.errorCode ?? "Failed"
  if (analysis.analysisType === "summary") return summaryTextOf(analysis.output) || "Summary ready"
  if (analysis.analysisType === "sentiment") {
    const sentiment = sentimentOf(analysis.output)
    return sentiment === null ? "Sentiment ready" : `Sentiment: ${sentiment.label}`
  }
  if (analysis.analysisType === "action_items") {
    const count = actionItemsOf(analysis.output).length
    return count === 1 ? "1 action item" : `${String(count)} action items`
  }
  const topics = topicsOf(analysis.output)
  return topics.length === 0 ? "No topics found" : topics.map((t) => t.topic).join(", ")
}
