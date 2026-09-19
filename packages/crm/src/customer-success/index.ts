export {
  CsAccountNotFoundError,
  CsPlaybookNotFoundError,
  CsRenewalNotFoundError,
  createCustomerSuccessService,
} from "./service"
export type { CustomerSuccessService } from "./service"
export { CS_OBJECT, csPermission, isWorkspaceAdmin, resolveAccountRowScope } from "./access"
export {
  applyCsPlaybookSchema,
  createCsAccountSchema,
  createCsRenewalSchema,
  csAccountQuerySchema,
  csAccountSchema,
  csHealthFactorSchema,
  csHealthScoreSchema,
  csLifecycleStageSchema,
  csPlaybookCatalogEntrySchema,
  csPlaybookTaskSchema,
  csRenewalQuerySchema,
  csRenewalSchema,
  csRenewalStatusSchema,
  updateCsAccountSchema,
  updateCsRenewalSchema,
} from "./schemas"
export type {
  ApplyCsPlaybookInput,
  CreateCsAccountInput,
  CreateCsRenewalInput,
  CsAccountDto,
  CsAccountQuery,
  CsHealthScoreDto,
  CsPlaybookTaskDto,
  CsRenewalDto,
  CsRenewalQuery,
  UpdateCsAccountInput,
  UpdateCsRenewalInput,
} from "./schemas"
export type {
  CsAccountListQuery,
  CsAccountListResult,
  CsAccountRecord,
  CsAccountRowScope,
  CsHealthComputation,
  CsHealthFactor,
  CsHealthScoreRecord,
  CsPlaybookCatalogEntry,
  CsPlaybookDefinition,
  CsPlaybookTaskRecord,
  CsPlaybookTaskTemplate,
  CsRenewalListQuery,
  CsRenewalListResult,
  CsRenewalRecord,
  CustomerSuccessServiceContext,
  CustomerSuccessServiceDeps,
  CustomerSuccessStore,
  PlaybookTaskInput,
  PlaybookTaskRecord,
  TasksPort,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
