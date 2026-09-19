export {
  computeTotals,
  createQuotesService,
  InvalidQuoteTransitionError,
  QuoteNotFoundError,
} from "./service"
export type { QuotesService, QuoteMoneyInput } from "./service"
export {
  createQuoteSchema,
  quoteLineItemInputSchema,
  quoteQuerySchema,
  quoteSchema,
  updateQuoteSchema,
} from "./schemas"
export type { CreateQuoteInput, QuoteDto, QuoteQuery, UpdateQuoteInput } from "./schemas"
export type {
  QuoteAuditInput,
  QuoteLineItemRecord,
  QuoteListQuery,
  QuoteListResult,
  QuoteRecord,
  QuotesServiceContext,
  QuotesServiceDeps,
  QuotesStore,
  QuoteTotals,
  QuoteWithDetails,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
