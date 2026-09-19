/**
 * Read-side timezone rendering for the calendar web pages.
 *
 * This intentionally duplicates `packages/crm/src/calendar/timezone.ts`
 * (the source of truth, unit-tested there) rather than importing it: per
 * `docs/architecture.md`, "the web app talks to the API via
 * `lib/api-client.ts` only" and never imports domain packages directly —
 * `apps/web/package.json` has no `@yourcrm/crm` dependency, and this module
 * may not add one (see `CLAUDE.md` hard rules: no `bun add`, no editing
 * `package.json`). The logic is small, pure and framework-free, so the
 * duplication is cheap and keeps the architecture boundary intact.
 *
 * Storage rule (spec 13-calendar, P0): every timestamp on the wire is UTC
 * ISO (`timestamptz` as stored). Rendering it in the workspace's local
 * timezone (`workspaceTimezone`, returned alongside calendar API responses)
 * happens here, using only `Intl` and the standard `Date` — no date library
 * is installed in this workspace.
 */

export type LocalDateTimeParts = {
  year: number
  /** 1-12 */
  month: number
  day: number
  /** 0-23, workspace-local */
  hour: number
  minute: number
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
  return { year, month, day, hour, minute, isoDate: `${year}-${pad2(month)}-${pad2(day)}` }
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
 * user in the workspace timezone (a form's date + time fields), return the
 * UTC instant to submit. See the sibling implementation in
 * `packages/crm/src/calendar/timezone.ts` for the two-pass correction this
 * uses and its P0 DST-boundary caveat.
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
