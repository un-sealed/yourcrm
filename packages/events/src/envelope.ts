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
  LeadUpdated: "lead.updated",
  LeadQualified: "lead.qualified",
  LeadConverted: "lead.converted",
  DealCreated: "deal.created",
  DealUpdated: "deal.updated",
  DealStageChanged: "deal.stage_changed",
  DealWon: "deal.won",
  DealLost: "deal.lost",
  ActivityCreated: "activity.created",
  ActivityUpdated: "activity.updated",
  ActivityCompleted: "activity.completed",
  ActivityDeleted: "activity.deleted",
  TaskCreated: "task.created",
  TaskUpdated: "task.updated",
  TaskCompleted: "task.completed",
  TaskDeleted: "task.deleted",
  PersonDeleted: "person.deleted",
  CompanyDeleted: "company.deleted",
  LeadDeleted: "lead.deleted",
  DealDeleted: "deal.deleted",
} as const

export const CommunicationEvents = {
  EmailReceived: "email.received",
  EmailSent: "email.sent",
  EmailBounced: "email.bounced",
  EmailThreadLinked: "email.thread_linked",
  MessageReceived: "message.received",
  MessageSent: "message.sent",
  CallStarted: "call.started",
  CallAnswered: "call.answered",
  CallCompleted: "call.completed",
  CallRecordingReady: "call.recording_ready",
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
  ChatStarted: "ai.chat_started",
  WriteApproved: "ai.write_approved",
  WriteCompleted: "ai.write_completed",
  ActionRejected: "ai.action_rejected",
  ActionApplied: "ai.action_applied",
  PolicyChanged: "ai.policy_changed",
  KillSwitchEnabled: "ai.kill_switch_enabled",
  AgentCompleted: "agent.completed",
} as const

export const PipelineEvents = {
  PipelineCreated: "pipeline.created",
  PipelineUpdated: "pipeline.updated",
  PipelineStageReordered: "pipeline.stage_reordered",
} as const

export const ProductEvents = {
  ProductCreated: "product.created",
  ProductUpdated: "product.updated",
  ProductArchived: "product.archived",
  ProductDeleted: "product.deleted",
} as const

export const FormEvents = {
  FormCreated: "form.created",
  FormUpdated: "form.updated",
  FormSubmitted: "form.submitted",
} as const

export const FileEvents = {
  FileUploaded: "file.uploaded",
  FileDeleted: "file.deleted",
} as const

export const TransferEvents = {
  ImportStarted: "import.started",
  ImportCompleted: "import.completed",
  ExportCompleted: "export.completed",
} as const

export const QuoteEvents = {
  Created: "quote.created",
  Updated: "quote.updated",
  Sent: "quote.sent",
  Accepted: "quote.accepted",
  Rejected: "quote.rejected",
} as const

export const InvoiceEvents = {
  Created: "invoice.created",
  Updated: "invoice.updated",
  Sent: "invoice.sent",
  Paid: "invoice.paid",
  PaymentRecorded: "payment.recorded",
} as const

export const CalendarEvents = {
  EventCreated: "calendar.event_created",
  EventUpdated: "calendar.event_updated",
  EventDeleted: "calendar.event_deleted",
} as const

export const ReportEvents = {
  Created: "report.created",
  Updated: "report.updated",
  Run: "report.run",
} as const

export const DashboardEvents = {
  Created: "dashboard.created",
  Updated: "dashboard.updated",
} as const

export const SearchEvents = {
  Executed: "search.executed",
  CommandExecuted: "command.executed",
} as const

export const IntegrationEvents = {
  Connected: "integration.connected",
  Disconnected: "integration.disconnected",
  Reconnected: "integration.reconnected",
  HealthChecked: "integration.health_checked",
  Errored: "integration.error",
  WebhookReceived: "integration.webhook_received",
} as const

export const CustomObjectEvents = {
  ObjectCreated: "custom_object.created",
  ObjectUpdated: "custom_object.updated",
  ObjectDeleted: "custom_object.deleted",
  FieldCreated: "custom_field.created",
  FieldUpdated: "custom_field.updated",
  FieldDeleted: "custom_field.deleted",
  SchemaUpdated: "schema.updated",
  RecordCreated: "custom_record.created",
  RecordUpdated: "custom_record.updated",
  RecordDeleted: "custom_record.deleted",
} as const

export const ConversationEvents = {
  Assigned: "conversation.assigned",
  Unassigned: "conversation.unassigned",
  Read: "conversation.read",
  Archived: "conversation.archived",
  Closed: "conversation.closed",
} as const

/**
 * Marketplace / Plugin SDK events (spec 49-marketplace-sdk). `entityType`
 * is `"app_installation"`; `entityId` the installation id. `after` carries
 * the granted (and, on install, denied) scopes — never a credential, since
 * this module never issues or stores one.
 */
export const MarketplaceEvents = {
  AppRegistered: "app.registered",
  AppInstalled: "app.installed",
  AppUninstalled: "app.uninstalled",
  AppScopeDenied: "app.scope_denied",
  AppError: "app.error",
} as const
