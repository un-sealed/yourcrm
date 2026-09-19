/** Attendee as returned by `GET /api/v1/calendar-events/:id` (nested in `data`). */
export type CalendarAttendee = {
  id: string
  eventId: string
  userId: string | null
  email: string | null
  name: string | null
  responseStatus: string
  isOrganizer: boolean
}

/** Calendar event as returned by `GET /api/v1/calendar-events` (envelope `data` item). */
export type CalendarEvent = {
  id: string
  workspaceId: string
  ownerId: string | null
  title: string
  description: string | null
  location: string | null
  /** UTC ISO instant, as stored (`timestamptz`). Render via `@yourcrm/crm/src/calendar/timezone`. */
  startAt: string
  endAt: string
  allDay: boolean
  status: "confirmed" | "cancelled"
  personId: string | null
  companyId: string | null
  dealId: string | null
  createdAt: string
  updatedAt: string
}

export type CalendarEventDetail = CalendarEvent & { attendees: CalendarAttendee[] }

export type CalendarEventListResponse = {
  data: CalendarEvent[]
  pagination: { nextCursor: string | null; limit: number }
  /** `workspaces.timezone` — render every timestamp in the response with this, never the browser's. */
  workspaceTimezone: string
}

export type CalendarEventDetailResponse = {
  data: CalendarEventDetail
  workspaceTimezone: string
}

/** Attendee row shape used by the create/edit forms before submission. */
export type AttendeeDraft = {
  key: string
  kind: "internal" | "external"
  value: string
}
