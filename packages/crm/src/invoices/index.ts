export { computeInvoiceTotals, createInvoicesService, InvoiceNotFoundError, isOverdue } from "./service"
export type { InvoicesService } from "./service"
export {
  createInvoiceSchema,
  invoiceLineItemInputSchema,
  invoiceQuerySchema,
  invoiceSchema,
  recordPaymentSchema,
  updateInvoiceSchema,
} from "./schemas"
export type {
  CreateInvoiceInput,
  InvoiceDto,
  InvoiceQuery,
  RecordPaymentInput,
  UpdateInvoiceInput,
} from "./schemas"
export type {
  InvoiceAuditInput,
  InvoiceLineItemRecord,
  InvoiceListQuery,
  InvoiceListResult,
  InvoiceRecord,
  InvoicesServiceContext,
  InvoicesServiceDeps,
  InvoicesStore,
  InvoiceTotals,
  InvoiceWithDetails,
  PaymentRecord,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
