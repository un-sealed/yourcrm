import { z } from "zod"

/**
 * Canonical event envelope (specs 01-architecture + EVENTS-AND-INTEGRATIONS).
 * Every producer includes workspace + actor; never includes secrets.
 * Consumers must be idempotent.
 */
export const eventEnvelopeSchema = z.object({
  eventId: z.string(),
  event: z.string(),
  timestamp: z.string(),
  workspaceId: z.string(),
  actorId: z.string().optional(),
  actorType: z.enum(["user", "automation", "ai", "integration", "mcp", "system"]).default("user"),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  correlationId: z.string().optional(),
  schemaVersion: z.number().int().default(1),
})

export type DomainEvent = z.infer<typeof eventEnvelopeSchema>

export function createEvent(input: {
  event: string
  workspaceId: string
  actorId?: string
  actorType?: DomainEvent["actorType"]
  entityType?: string
  entityId?: string
  before?: unknown
  after?: unknown
  correlationId?: string
}): DomainEvent {
  return {
    eventId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: new Date().toISOString(),
    schemaVersion: 1,
    actorType: "user",
    ...input,
  }
}

// Event name constants grouped by domain (EVENTS-AND-INTEGRATIONS.md).
export const CrmEvents = {
  PersonCreated: "person.created",
  PersonUpdated: "person.updated",
  PersonMerged: "person.merged",
  CompanyCreated: "company.created",
  CompanyUpdated: "company.updated",
  LeadCreated: "lead.created",
  LeadQualified: "lead.qualified",
  LeadConverted: "lead.converted",
  DealCreated: "deal.created",
  DealStageChanged: "deal.stage_changed",
  DealWon: "deal.won",
  DealLost: "deal.lost",
  ActivityCreated: "activity.created",
  ActivityCompleted: "activity.completed",
  TaskCreated: "task.created",
  TaskCompleted: "task.completed",
} as const

export const CommunicationEvents = {
  EmailReceived: "email.received",
  EmailSent: "email.sent",
  MessageReceived: "message.received",
  MessageSent: "message.sent",
  CallCompleted: "call.completed",
  CalendarEventSynced: "calendar.event_synced",
} as const

export const AutomationEvents = {
  RunStarted: "workflow.run_started",
  StepFailed: "workflow.step_failed",
  Completed: "workflow.completed",
} as const

export const AiEvents = {
  ToolCalled: "ai.tool_called",
  ActionRequested: "ai.action_requested",
  ActionApproved: "ai.action_approved",
  ActionReverted: "ai.action_reverted",
  AgentCompleted: "agent.completed",
} as const
