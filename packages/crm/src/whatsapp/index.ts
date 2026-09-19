export {
  createWhatsAppService,
  WhatsAppConversationNotFoundError,
  WhatsAppNotConnectedError,
  WhatsAppSendFailedError,
  WhatsAppSessionWindowClosedError,
  WhatsAppTemplateNotApprovedError,
  WhatsAppTemplateNotFoundError,
} from "./service"
export type { WhatsAppService } from "./service"

export {
  isWhatsAppSessionWindowOpen,
  WHATSAPP_SESSION_WINDOW_MS,
  whatsAppSessionWindowRemainingMs,
} from "./session-window"

export {
  createWhatsAppConversationSchema,
  createWhatsAppTemplateSchema,
  sendWhatsAppMessageSchema,
  sendWhatsAppTemplateMessageSchema,
  sendWhatsAppTextMessageSchema,
  updateWhatsAppConversationSchema,
  whatsAppConversationQuerySchema,
  whatsAppConversationSchema,
  whatsAppConversationStatusSchema,
  whatsAppMessageQuerySchema,
  whatsAppMessageSchema,
  whatsAppTemplateSchema,
} from "./schemas"
export type {
  CreateWhatsAppConversationInput,
  CreateWhatsAppTemplateInput,
  SendWhatsAppMessageInput,
  UpdateWhatsAppConversationInput,
  WhatsAppConversationDto,
  WhatsAppConversationQuery,
  WhatsAppMessageDto,
  WhatsAppMessageQuery,
  WhatsAppTemplateDto,
} from "./schemas"

export {
  createWhatsAppConsoleProvider,
  consoleWhatsAppConfigSchema,
  WHATSAPP_CONSOLE_PROVIDER_ID,
} from "./providers/console-provider"
export type { ConsoleWhatsAppProviderOptions } from "./providers/console-provider"

export type {
  WhatsAppAuditInput,
  WhatsAppConnectionPort,
  WhatsAppConnectionRecord,
  WhatsAppConversationListQuery,
  WhatsAppConversationRecord,
  WhatsAppConversationStore,
  WhatsAppInboundMedia,
  WhatsAppInboundMessageInput,
  WhatsAppInboundStatusInput,
  WhatsAppListResult,
  WhatsAppMessageRecord,
  WhatsAppMessageStore,
  WhatsAppProviderAdapter,
  WhatsAppSendResult,
  WhatsAppSendTemplateInput,
  WhatsAppSendTextInput,
  WhatsAppServiceContext,
  WhatsAppServiceDeps,
  WhatsAppTemplateRecord,
  WhatsAppTemplateStore,
} from "./types"

// Shared across every CRM module — see ../ports.ts for why they live here.
export type { AuditWriter, EventEmitter } from "../ports"
