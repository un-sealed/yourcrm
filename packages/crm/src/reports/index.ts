export { ReportNotFoundError, createReportsService } from "./service"
export type { ReportsService } from "./service"
export {
  REPORT_OBJECT,
  assertReportVisible,
  isWorkspaceAdmin,
  reportPermission,
  resolveReportListScope,
  resolveReportRowScope,
} from "./access"
export {
  REPORT_MAX_ROWS,
  createReportSchema,
  reportAggregateFunctions,
  reportAggregationSchema,
  reportColumnsSchema,
  reportFilterOperatorSchema,
  reportFilterOperators,
  reportFilterTreeSchema,
  reportQuerySchema,
  reportResultSchema,
  reportSchema,
  reportSortSchema,
  runReportSchema,
  updateReportSchema,
} from "./schemas"
export type {
  CreateReportInput,
  ReportDto,
  ReportQuery,
  RunReportInput,
  UpdateReportInput,
} from "./schemas"
export type {
  ReportAuditInput,
  ReportExecutionRequest,
  ReportExecutionResult,
  ReportFilterCondition,
  ReportFilterGroup,
  ReportFilterNode,
  ReportFilterTree,
  ReportListQuery,
  ReportListResult,
  ReportListScope,
  ReportObjectCatalogEntry,
  ReportRecord,
  ReportResultColumn,
  ReportRowScope,
  ReportsServiceContext,
  ReportsServiceDeps,
  ReportsStore,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
