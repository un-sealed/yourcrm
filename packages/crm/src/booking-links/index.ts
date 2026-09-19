export {
  BookingLinkNotFoundError,
  BookingNotFoundError,
  BookingSlotUnavailableError,
  createBookingLinksService,
} from "./service"
export type { BookingLinksService } from "./service"
export {
  addCalendarDays,
  calendarDaysBetween,
  computeBookableSlots,
  isBookableSlot,
  weekdayOfCalendarDate,
} from "./slots"
export type { ComputeBookableSlotsOptions } from "./slots"
export {
  BOOKING_LINK_STATUSES,
  BOOKING_STATUSES,
  bookingAvailabilityQuerySchema,
  bookingAvailabilityRuleInputSchema,
  bookingAvailabilityRuleSchema,
  bookingLinkQuerySchema,
  bookingLinkSchema,
  bookingQuerySchema,
  bookingSchema,
  bookingSlotSchema,
  cancelBookingSchema,
  createBookingLinkSchema,
  createBookingSchema,
  publicBookingLinkSchema,
  publicBookingSchema,
  replaceBookingAvailabilityRulesSchema,
  updateBookingLinkSchema,
} from "./schemas"
export type {
  BookingAvailabilityQuery,
  BookingAvailabilityRuleDto,
  BookingAvailabilityRuleInput,
  BookingDto,
  BookingLinkDto,
  BookingLinkQuery,
  BookingSlotDto,
  CreateBookingInput as CreateBookingApiInput,
  CreateBookingLinkInput,
  PublicBookingDto,
  PublicBookingLinkDto,
  UpdateBookingLinkInput,
} from "./schemas"
export type {
  BookingAvailabilityRuleRecord,
  BookingBusyInterval,
  BookingLinkAuditInput,
  BookingLinkListQuery,
  BookingLinkListResult,
  BookingLinkRecord,
  BookingLinksServiceContext,
  BookingLinksServiceDeps,
  BookingLinksStore,
  BookingLinkWithRules,
  BookingListQuery,
  BookingListResult,
  BookingRecord,
  BookingSlot,
  CreateBookingInput,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
