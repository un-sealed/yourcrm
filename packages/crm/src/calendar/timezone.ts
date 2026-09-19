/**
 * Read-side timezone rendering for the calendar module.
 *
 * Storage rule (spec 13-calendar, P0): every timestamp lands in Postgres as
 * `timestamptz` — an absolute UTC instant, never pre-converted. Rendering in
 * the workspace's local timezone (`workspaces.timezone`, IANA name such as
 * `"America/New_York"`) happens here, at read time, using only `Intl` and
 * the standard `Date` (no date library is installed in this workspace).
 *
 * This is the classic calendar bug: converting a UTC instant to "local time"
 * by string-slicing or applying a fixed offset silently rolls events onto
 * the wrong calendar day around midnight, and breaks across DST transitions.
 * `Intl.DateTimeFormat` with an explicit IANA `timeZone` is DST-aware and is
 * the only correct way to do this without a date library.
 */

export type LocalDateTimeParts = {
  year: number
  /** 1-12 */
  month: number
  day: number
  /** 0-23, workspace-local */
  hour: number
  minute: number
  /** Short weekday name, e.g. "Mon". */
  weekday: string
  /** `YYYY-MM-DD` in the workspace timezone — the calendar-day grouping key. */
  isoDate: string
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/**
 * Break a UTC instant into its workspace-local calendar/clock parts.
 * Throws on an invalid `isoUtc` or unknown IANA `timeZone`.
 */
export function toWorkspaceLocalParts(isoUtc: string, timeZone: string): LocalDateTimeParts {
  const date = new Date(isoUtc)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`toWorkspaceLocalParts: invalid date "${isoUtc}"`)
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? ""
  const year = Number(get("year"))
  const month = Number(get("month"))
  const day = Number(get("day"))
  // Some locales render midnight as "24" under hour12: false.
  const rawHour = Number(get("hour"))
  const hour = rawHour === 24 ? 0 : rawHour
  const minute = Number(get("minute"))
  const weekday = get("weekday")
  return { year, month, day, hour, minute, weekday, isoDate: `${year}-${pad2(month)}-${pad2(day)}` }
}

/** `"YYYY-MM-DD"` calendar-day key for the instant in the workspace timezone. */
export function localCalendarDateKey(isoUtc: string, timeZone: string): string {
  return toWorkspaceLocalParts(isoUtc, timeZone).isoDate
}

/** `"YYYY-MM-DD HH:mm"` in the workspace timezone — agenda/month-view label. */
export function formatEventDateTime(isoUtc: string, timeZone: string): string {
  const p = toWorkspaceLocalParts(isoUtc, timeZone)
  return `${p.isoDate} ${pad2(p.hour)}:${pad2(p.minute)}`
}

/** `"HH:mm"` in the workspace timezone — time-only label for timed events. */
export function formatEventTime(isoUtc: string, timeZone: string): string {
  const p = toWorkspaceLocalParts(isoUtc, timeZone)
  return `${pad2(p.hour)}:${pad2(p.minute)}`
}

export type WallClockParts = {
  year: number
  /** 1-12 */
  month: number
  day: number
  /** 0-23 */
  hour: number
  minute: number
}

/**
 * Inverse of `toWorkspaceLocalParts`: given wall-clock parts as entered by a
 * user in the workspace timezone (e.g. a form's date + time fields), return
 * the UTC instant to store.
 *
 * No `Intl` API converts a local wall-clock time to UTC directly, so this
 * uses the standard two-pass correction: guess the instant by treating the
 * wall clock as if it were already UTC, measure how far that guess's
 * rendering in `timeZone` drifted from the intended wall clock, and correct
 * by the difference. One pass is exact outside DST transition instants; a
 * form field landing exactly in a spring-forward gap or a fall-back overlap
 * (at most a couple of hours per year) resolves to one of the two valid
 * offsets rather than throwing — an acceptable P0 simplification with no
 * recurrence support.
 */
export function fromWorkspaceLocalParts(parts: WallClockParts, timeZone: string): Date {
  const guessMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  const guessLocal = toWorkspaceLocalParts(new Date(guessMs).toISOString(), timeZone)
  const guessAsUtcMs = Date.UTC(
    guessLocal.year,
    guessLocal.month - 1,
    guessLocal.day,
    guessLocal.hour,
    guessLocal.minute,
  )
  const driftMs = guessAsUtcMs - guessMs
  return new Date(guessMs - driftMs)
}
