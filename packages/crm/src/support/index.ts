export {
  computeSupportTicketSla,
  createSupportTicketService,
  DEFAULT_SUPPORT_TICKET_SLA_POLICY,
  filterPublicSupportTicketComments,
  InvalidSupportTicketTransitionError,
  SupportTicketNotFoundError,
} from "./service"
export type {
  SupportTicketService,
  SupportTicketSlaDueDates,
  SupportTicketSlaMinutes,
} from "./service"
export {
  createSupportTicketCommentSchema,
  createSupportTicketSchema,
  SUPPORT_TICKET_CHANNEL_VALUES,
  SUPPORT_TICKET_PRIORITY_VALUES,
  SUPPORT_TICKET_STATUS_VALUES,
  supportTicketCommentSchema,
  supportTicketQuerySchema,
  supportTicketSchema,
  transitionSupportTicketSchema,
  updateSupportTicketSchema,
} from "./schemas"
export type {
  CreateSupportTicketCommentInput,
  CreateSupportTicketInput,
  SupportTicketCommentDto,
  SupportTicketDto,
  SupportTicketQuery,
  TransitionSupportTicketInput,
  UpdateSupportTicketInput,
} from "./schemas"
export type {
  SupportTicketAuditInput,
  SupportTicketCommentRecord,
  SupportTicketListQuery,
  SupportTicketListResult,
  SupportTicketRecord,
  SupportTicketServiceContext,
  SupportTicketServiceDeps,
  SupportTicketStore,
  SupportTicketWithComments,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
