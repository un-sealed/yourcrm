export {
  createPortalService,
  portalScopeFor,
  PortalNotFoundError,
  PortalUnauthorizedError,
  PORTAL_MAGIC_LINK_TTL_MS,
  PORTAL_MAX_IDENTITIES_PER_EMAIL,
  PORTAL_SESSION_TTL_MS,
} from "./service"
export type { PortalRequestMeta, PortalService, PortalSessionGrantResult } from "./service"
export {
  isPublicPortalComment,
  toPortalInvoiceDetail,
  toPortalInvoiceSummary,
  toPortalLineItem,
  toPortalQuoteDetail,
  toPortalQuoteSummary,
  toPortalTicketComment,
  toPortalTicketDetail,
  toPortalTicketSummary,
  PORTAL_FORBIDDEN_KEYS,
} from "./redact"
export type {
  PortalInvoiceDto,
  PortalLineItemDto,
  PortalQuoteDto,
  PortalTicketCommentDto,
  PortalTicketDto,
} from "./redact"
export {
  portalIdentitySchema,
  portalInvoiceQuerySchema,
  portalInvoiceResponseSchema,
  portalInvoiceSchema,
  portalInvoiceStatusSchema,
  portalLineItemSchema,
  portalMagicLinkRequestSchema,
  portalQuoteQuerySchema,
  portalQuoteResponseSchema,
  portalQuoteSchema,
  portalQuoteStatusSchema,
  portalSessionExchangeSchema,
  portalTicketCommentSchema,
  portalTicketQuerySchema,
  portalTicketResponseSchema,
  portalTicketSchema,
  portalTicketStatusSchema,
} from "./schemas"
export type {
  PortalIdentityDto,
  PortalInvoiceQuery,
  PortalMagicLinkRequestInput,
  PortalQuoteQuery,
  PortalSessionExchangeInput,
  PortalTicketQuery,
} from "./schemas"
export { PORTAL_RESOURCES } from "./types"
export type {
  CreatePortalSessionRowInput,
  PortalAuditInput,
  PortalBillingReader,
  PortalContext,
  PortalGrantRecord,
  PortalGrantScopeType,
  PortalIdentityRecord,
  PortalIdentityStore,
  PortalInvoiceDetailSource,
  PortalMagicLinkDelivery,
  PortalMagicLinkMessage,
  PortalPage,
  PortalQuoteDetailSource,
  PortalReadQuery,
  PortalResource,
  PortalScope,
  PortalServiceDeps,
  PortalSessionRecord,
  PortalSessionStore,
  PortalSourceRecord,
  PortalTicketDetailSource,
  PortalTicketReader,
  PortalTokenPort,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
