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
  AuditWriter,
  DealAuditInput,
  DealListQuery,
  DealListResult,
  DealRecord,
  DealsServiceContext,
  DealsServiceDeps,
  DealsStore,
  EventEmitter,
} from "./types"
