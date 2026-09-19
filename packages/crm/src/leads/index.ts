export { createLeadsService, LeadNotFoundError } from "./service"
export type { LeadsService } from "./service"
export {
  convertLeadSchema,
  createLeadSchema,
  leadQuerySchema,
  leadSchema,
  leadSourceSchema,
  leadStatusSchema,
  updateLeadSchema,
} from "./types"
export type {
  ConvertLeadInput,
  CreateLeadInput,
  LeadDto,
  LeadQuery,
  UpdateLeadInput,
} from "./types"
export type {
  LeadAuditInput,
  LeadListQuery,
  LeadListResult,
  LeadRecord,
  LeadsServiceContext,
  LeadsServiceDeps,
  LeadsStore,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
