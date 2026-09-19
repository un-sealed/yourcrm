import type { BadgeTone } from "@yourcrm/ui"

/**
 * Client-side contracts for AI agents.
 *
 * The server owns every decision here. Nothing in this file is a
 * permission check: the page hides a button for convenience, the API
 * refuses for real. In particular, an agent's proposed changes are shown
 * as *proposals* everywhere, because that is what they are — the approval
 * queue at `/app/ai/governance` is where a human decides.
 */

export type AiAgentStatus = "disabled" | "enabled"

export type AiAgent = {
  id: string
  workspaceId: string
  name: string
  description: string | null
  instructions: string
  model: string | null
  tools: string[]
  triggerType: string
  triggerEvent: string | null
  triggerEntityType: string | null
  ownerId: string | null
  status: string
  maxSteps: number
  maxToolCalls: number
  maxTotalTokens: number
  lastRunAt: string | null
  createdAt: string
  updatedAt: string
  runs?: AiAgentRun[]
}

export type AiAgentRun = {
  id: string
  agentId: string
  triggerType: string
  triggerEvent: string | null
  triggerEventId: string
  status: string
  steps: number
  toolCallCount: number
  proposalCount: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  latencyMs: number
  costMicros: number | null
  model: string | null
  summary: string | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export type AiAgentsResponse = {
  data: AiAgent[]
  pagination: { nextCursor: string | null; limit: number }
}

export type AiAgentRunsResponse = {
  data: AiAgentRun[]
  pagination: { nextCursor: string | null; limit: number }
}

export const AI_AGENT_STATUS_TONES: Record<string, BadgeTone> = {
  enabled: "success",
  disabled: "secondary",
}

/**
 * Run statuses, in the words an operator needs.
 *
 * `exhausted` is deliberately not called an error: the agent hit the
 * budget it was given, and the fix is a bigger budget or a smaller task.
 */
export const AI_AGENT_RUN_STATUS_TONES: Record<string, BadgeTone> = {
  queued: "secondary",
  running: "info",
  succeeded: "success",
  failed: "destructive",
  exhausted: "warning",
  denied: "destructive",
  skipped: "outline",
}

export const AI_AGENT_RUN_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Finished",
  failed: "Failed",
  exhausted: "Stopped at its budget",
  denied: "Refused: the owner lacks permission",
  skipped: "Skipped",
}

export function describeAiAgentTrigger(agent: AiAgent): string {
  if (agent.triggerType === "manual") return "Runs when you press Run"
  const entity = agent.triggerEntityType === null ? "" : ` (${agent.triggerEntityType})`
  return `Runs on ${agent.triggerEvent ?? "an event"}${entity}`
}

/** Micro-USD -> a human number. `—` means the model has no known price. */
export function formatAiAgentCost(costMicros: number | null): string {
  if (costMicros === null) return "—"
  if (costMicros === 0) return "$0.00"
  const dollars = costMicros / 1_000_000
  return dollars < 0.01 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`
}

/** One line of accounting for a run row. */
export function describeAiAgentRun(run: AiAgentRun): string {
  const parts = [
    `${String(run.steps)} step${run.steps === 1 ? "" : "s"}`,
    `${String(run.toolCallCount)} tool call${run.toolCallCount === 1 ? "" : "s"}`,
    `${String(run.totalTokens)} tokens`,
    formatAiAgentCost(run.costMicros),
  ]
  if (run.proposalCount > 0) {
    parts.push(`${String(run.proposalCount)} change${run.proposalCount === 1 ? "" : "s"} proposed`)
  }
  return parts.join(" · ")
}

export function formatAiAgentTimestamp(value: string | null): string {
  return value === null ? "—" : new Date(value).toLocaleString()
}

/** Only an agent with an owner can be turned on — it runs as that person. */
export function canEnableAiAgent(agent: AiAgent): boolean {
  return agent.status === "disabled" && agent.ownerId !== null
}
