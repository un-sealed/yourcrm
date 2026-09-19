/**
 * Pure month-grid arithmetic for the calendar's month view — no date
 * library (none is installed), just `Date.UTC` anchors so the grid never
 * drifts with the browser's local timezone. `workspaces.timezone` is only
 * relevant when bucketing *events* onto grid cells
 * (`@yourcrm/crm/src/calendar/timezone.ts`'s `localCalendarDateKey`), never
 * for computing which calendar cells exist.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** `"YYYY-MM-DD"` for a UTC-anchored instant. */
function dateKeyFromUtcMs(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/** `"YYYY-MM-DD"` for explicit calendar parts (`month` is 0-11). */
export function dateKeyOf(year: number, month: number, day: number): string {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`
}

/** 42-cell (6-week) month grid of `"YYYY-MM-DD"` keys, weeks starting Sunday. */
export function buildMonthGrid(year: number, month: number): string[] {
  const firstOfMonth = Date.UTC(year, month, 1)
  const firstWeekday = new Date(firstOfMonth).getUTCDay() // 0 = Sunday
  const gridStart = firstOfMonth - firstWeekday * MS_PER_DAY
  return Array.from({ length: 42 }, (_, i) => dateKeyFromUtcMs(gridStart + i * MS_PER_DAY))
}

/**
 * Padded UTC ISO bounds for the `from`/`to` list query. Padded 8 days past
 * the strict month on each side: enough to cover the 6-week grid's leading
 * blank days plus any workspace-timezone skew (up to ±14h) around the
 * month boundary — the classic calendar bug, guarded against by over-
 * fetching rather than trying to invert the timezone conversion here.
 */
export function monthRangeUtcPadded(year: number, month: number): { from: string; to: string } {
  const PAD_DAYS = 8
  const firstOfMonth = Date.UTC(year, month, 1)
  const firstOfNextMonth = Date.UTC(year, month + 1, 1)
  return {
    from: new Date(firstOfMonth - PAD_DAYS * MS_PER_DAY).toISOString(),
    to: new Date(firstOfNextMonth + PAD_DAYS * MS_PER_DAY).toISOString(),
  }
}

/** `true` when `key` (`"YYYY-MM-DD"`) falls in the given calendar month. */
export function isInMonth(key: string, year: number, month: number): boolean {
  return key.startsWith(`${year}-${pad2(month + 1)}-`)
}

/** Day-of-month number parsed from a `"YYYY-MM-DD"` key. */
export function dayOfKey(key: string): number {
  return Number(key.slice(8, 10))
}

/** `{ year, month }` (0-11) shifted by `delta` whole months. */
export function shiftMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const total = year * 12 + month + delta
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 }
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

/** `"June 2026"` label for a calendar month (`month` is 0-11). */
export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month]} ${year}`
}
