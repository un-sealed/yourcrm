export {
  DashboardNotFoundError,
  DashboardWidgetNotFoundError,
  createDashboardsService,
} from "./service"
export type { DashboardsService } from "./service"
export {
  createDashboardSchema,
  createWidgetSchema,
  dashboardQuerySchema,
  dashboardSchema,
  dashboardWidgetInputSchema,
  dashboardWidgetSchema,
  repositionWidgetSchema,
  updateDashboardSchema,
  updateWidgetSchema,
  widgetTypeSchema,
} from "./schemas"
export type {
  CreateDashboardInput,
  CreateWidgetInput,
  DashboardDto,
  DashboardQuery,
  DashboardWidgetDto,
  RepositionWidgetInput,
  UpdateDashboardInput,
  UpdateWidgetInput,
  WidgetType,
} from "./schemas"
export type {
  DashboardAuditInput,
  DashboardListQuery,
  DashboardListResult,
  DashboardRecord,
  DashboardsServiceContext,
  DashboardsServiceDeps,
  DashboardsStore,
  DashboardWidgetRecord,
  DashboardWithWidgets,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live here.
export type { AuditWriter, EventEmitter } from "../ports"
