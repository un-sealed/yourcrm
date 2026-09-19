export { DealNotFoundError, createDealsService, weightedValue } from "./service"
export type { DealsService } from "./service"
export {
  changeDealStageSchema,
  closeDealSchema,
  createDealSchema,
  dealQuerySchema,
  dealSchema,
  dealStageSchema,
  updateDealSchema,
} from "./service"
export type {
  ChangeDealStageInput,
  CloseDealInput,
  CreateDealInput,
  DealDto,
  DealQuery,
  DealStageInput,
  UpdateDealInput,
} from "./service"
export type {
  DealAuditInput,
  DealListQuery,
  DealListResult,
  DealRecord,
  DealsServiceContext,
  DealsServiceDeps,
  DealsStore,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
