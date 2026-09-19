export { AppNotificationNotFoundError, createNotificationsService } from "./service"
export type { NotificationsService } from "./service"
export {
  appNotificationSchema,
  createAppNotificationSchema,
  DEFAULT_CHANNEL_TOGGLES,
  isNotificationCategory,
  notificationCategoryPatchSchema,
  notificationChannelTogglesSchema,
  notificationListQuerySchema,
  notificationPreferenceSchema,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  updateNotificationPreferencesSchema,
} from "./schemas"
export type {
  AppNotificationDto,
  CreateAppNotificationInput,
  NotificationCategory,
  NotificationChannel,
  NotificationChannelToggles,
  NotificationListQuery,
  NotificationPreferenceDto,
  UpdateNotificationPreferencesInput,
} from "./schemas"
export {
  defaultPreference,
  isChannelEnabled,
  isWithinQuietHours,
  resolveChannels,
  toEffectivePreference,
} from "./preferences"
export type { EffectivePreference } from "./preferences"
export type {
  AppNotification,
  NotificationAuditInput,
  NotificationDeliveryPort,
  NotificationListResult,
  NotificationPreferenceRecord,
  NotificationPreferencesPatch,
  NotificationPreferencesStore,
  NotificationsServiceContext,
  NotificationsServiceDeps,
  NotificationsStore,
  NotificationStoreCreateInput,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
