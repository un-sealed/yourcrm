/**
 * Email module (spec 14-email, P0).
 *
 * Every export is prefixed `Email`/`email` on purpose: `../index.ts` is a
 * single generated `export *` barrel across all CRM modules, so a generic
 * name (`Message`, `Thread`, `sanitizeHtml`) would collide.
 */

export {
  createEmailService,
  EmailConnectionUnavailableError,
  EmailMessageNotFoundError,
  EmailSendFailedError,
  EmailSenderAddressMissingError,
  EmailThreadNotFoundError,
  EmailTransportUnavailableError,
} from "./service"
export type { EmailInboundResult, EmailService } from "./service"

export {
  emailAddressInputSchema,
  emailAttachmentInputSchema,
  emailAttachmentSchema,
  emailMessageSchema,
  emailParticipantSchema,
  emailThreadQuerySchema,
  emailThreadSchema,
  emailThreadStatusSchema,
  inboundEmailMessageSchema,
  sendEmailMessageSchema,
  updateEmailThreadSchema,
} from "./schemas"
export type {
  EmailAddressInput,
  EmailAttachmentDto,
  EmailAttachmentInput,
  EmailMessageDto,
  EmailParticipantDto,
  EmailThreadDto,
  EmailThreadQuery,
  InboundEmailMessageInput,
  SendEmailMessageInput,
  UpdateEmailThreadInput,
} from "./schemas"

export {
  emailAncestorIds,
  emailParticipantKey,
  normalizeEmailAddress,
  normalizeEmailMessageId,
  normalizeEmailSubject,
  parseEmailReferenceChain,
  resolveEmailThread,
} from "./threading"
export type {
  EmailAncestorMatchRecord,
  EmailThreadLookupPort,
  EmailThreadResolution,
  EmailThreadResolutionInput,
} from "./threading"

export {
  emailDisplayText,
  emailHtmlToText,
  emailSnippetOf,
  isUnsafeEmailUrl,
  sanitizeEmailHtml,
} from "./sanitize"

export {
  CONSOLE_EMAIL_PROVIDER_ID,
  consoleEmailConfigSchema,
  consoleInboundEmailPayloadSchema,
  createConsoleEmailProvider,
} from "./console-email-provider"
export type {
  ConsoleEmailConfig,
  ConsoleEmailOutboxEntry,
  ConsoleEmailProvider,
  ConsoleEmailProviderOptions,
  ConsoleInboundEmailPayload,
} from "./console-email-provider"

export { createEmailTransportCatalog } from "./types"
export type {
  EmailAttachmentRecord,
  EmailAuditInput,
  EmailConnectionStore,
  EmailMessageDetail,
  EmailMessageRecord,
  EmailMessageStore,
  EmailOutboundConnectionRecord,
  EmailParticipantRecord,
  EmailSecretReader,
  EmailServiceContext,
  EmailServiceDeps,
  EmailThreadDetail,
  EmailThreadListQuery,
  EmailThreadListResult,
  EmailThreadRecord,
  EmailThreadStore,
  EmailTransportAddress,
  EmailTransportCatalogPort,
  EmailTransportContext,
  EmailTransportPort,
  EmailTransportSendInput,
  EmailTransportSendResult,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
