export { CalendarEventNotFoundError, createCalendarService } from "./service"
export type { CalendarService } from "./service"
export {
  ATTENDEE_RESPONSE_STATUSES,
  CALENDAR_EVENT_STATUSES,
  calendarAttendeeInputSchema,
  calendarAttendeeSchema,
  calendarEventQuerySchema,
  calendarEventSchema,
  createCalendarEventSchema,
  updateCalendarEventSchema,
} from "./schemas"
export type {
  CalendarAttendeeDto,
  CalendarAttendeeInput,
  CalendarEventDto,
  CalendarEventQuery,
  CreateCalendarEventInput,
  UpdateCalendarEventInput,
} from "./schemas"
export {
  formatEventDateTime,
  formatEventTime,
  fromWorkspaceLocalParts,
  localCalendarDateKey,
  toWorkspaceLocalParts,
} from "./timezone"
export type { LocalDateTimeParts, WallClockParts } from "./timezone"
export type {
  CalendarAttendeeRecord,
  CalendarAuditInput,
  CalendarEventListQuery,
  CalendarEventListResult,
  CalendarEventRecord,
  CalendarEventWithAttendees,
  CalendarServiceContext,
  CalendarServiceDeps,
  CalendarStore,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
