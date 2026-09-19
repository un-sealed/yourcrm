export { ActivityNotFoundError, createActivitiesService } from "./service"
export type { ActivitiesService } from "./service"
export {
  ACTIVITY_STATUSES,
  ACTIVITY_SUBJECT_TYPES,
  ACTIVITY_TYPES,
  activityQuerySchema,
  activitySchema,
  activityTimelineQuerySchema,
  createActivitySchema,
  updateActivitySchema,
} from "./service"
export type {
  ActivityDto,
  ActivityQuery,
  ActivityTimelineQuery,
  CreateActivityInput,
  UpdateActivityInput,
} from "./service"
export type {
  ActivitiesServiceContext,
  ActivitiesServiceDeps,
  ActivitiesStore,
  ActivityListQuery,
  ActivityListResult,
  ActivityRecord,
  ActivityTimelineQuery as ActivityTimelineStoreQuery,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
