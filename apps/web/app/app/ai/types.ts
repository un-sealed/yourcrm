/**
 * Wire types and pure view helpers for the AI assistant page
 * (spec 34-ai-assistant, P0). Kept out of `page.tsx` so the formatting
 * rules are unit-testable without rendering React.
 */

export type AiConversation = {
  id: string
  workspaceId: string
  title: string
  userId: string | null
  model: string | null
  lastMessageAt: string | null
  createdAt: string
  updatedAt: string
}

export type AiMessage = {
  id: string
  conversationId: string
  role: "user" | "assistant" | "tool" | "system"
  content: string
  model: string | null
  providerId: string | null
  runId: string | null
  toolCalls: unknown
  toolCallId: string | null
  toolName: string | null
  createdAt: string
}

export type AiRun = {
  id: string
  conversationId: string
  providerId: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  latencyMs: number
  costMicros: number | null
  outcome: string
  toolCallCount: number
  createdAt: string
}

export type AiToolCallReport = {
  id: string
  name: string
  outcome: "succeeded" | "failed" | "denied"
  summary: string
  durationMs: number
}

export type AiConversationsResponse = {
  data: AiConversation[]
  pagination: { nextCursor: string | null; limit: number }
}

export type AiConversationDetail = {
  conversation: AiConversation
  messages: AiMessage[]
  runs: AiRun[]
}

export type AiAskResponse = {
  conversation: AiConversation
  userMessage: AiMessage
  assistantMessage: AiMessage
  run: AiRun
  toolCalls: AiToolCallReport[]
}

export type AiProviderStatus = {
  providerId: string
  model: string
  tools: { name: string; description: string }[]
}

/** Only the two prose roles are rendered as chat bubbles. */
export function isChatBubble(message: AiMessage): boolean {
  return (message.role === "user" || message.role === "assistant") && message.content.trim() !== ""
}

/**
 * Attribution line under an assistant answer (spec 34 §14: every AI output
 * is attributable to a model and a run).
 */
export function describeAttribution(message: AiMessage, run?: AiRun): string {
  const parts: string[] = []
  if (message.model) parts.push(message.model)
  else if (run) parts.push(run.model)
  if (run) {
    parts.push(`${String(run.totalTokens)} tokens`)
    parts.push(`${String(run.latencyMs)} ms`)
    if (run.costMicros !== null) parts.push(formatCostMicros(run.costMicros))
  }
  return parts.join(" · ")
}

/** Micro-USD (1e-6 USD) as a short, honest string. */
export function formatCostMicros(costMicros: number): string {
  if (costMicros === 0) return "<$0.000001"
  return `$${(costMicros / 1_000_000).toFixed(6)}`
}

/** Tool-call transparency badge tone. */
export function toolOutcomeTone(
  outcome: AiToolCallReport["outcome"],
): "success" | "warning" | "destructive" {
  if (outcome === "succeeded") return "success"
  return outcome === "denied" ? "warning" : "destructive"
}

/** Tool calls belonging to one run, in order, for the transparency panel. */
export function toolCallsForRun(messages: AiMessage[], runId: string): AiMessage[] {
  return messages.filter((message) => message.role === "tool" && message.runId === runId)
}

export function formatTimestamp(value: string | null): string {
  if (!value) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString()
}
