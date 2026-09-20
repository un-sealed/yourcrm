/**
 * Categorical series palette for dashboard charts.
 *
 * Single source of truth for spec `docs/design/DASHBOARD-REDESIGN.md` §1.
 * Slots are assigned **in fixed order** and colour follows the **entity**,
 * never its rank: filtering a series out must not repaint the survivors. A
 * 6th series folds into "Other" — never generate a new hue.
 *
 * Components consume the palette through CSS custom properties
 * (`--chart-1` … `--chart-5`) so dark mode resolves to the dark column via
 * the `.dark` selector. `chartTokensCss()` emits those declarations; every
 * chart embeds it in a `<style>` tag so the components are self-sufficient
 * and `apps/web/app/globals.css` only needs to mirror the same values.
 *
 * Slots 2 and 3 sit below 3:1 contrast on white, so any chart using them
 * must carry visible direct labels or a table view (spec §1).
 */

export type ChartThemeMode = "light" | "dark"

export interface ChartSeriesSlot {
  /** 1-based fixed slot. Colour follows the entity in this slot, never its rank. */
  slot: number
  /** Hex for light mode (default theme). */
  light: string
  /** Hex for dark mode (selected values, not a filter flip). */
  dark: string
  /** CSS custom property backing this slot. */
  varName: string
}

/** Number of categorical slots. Anything beyond this folds into "Other". */
export const MAX_CHART_SERIES = 5

export const CHART_SERIES_SLOTS: readonly ChartSeriesSlot[] = [
  { slot: 1, light: "#2563eb", dark: "#3b82f6", varName: "--chart-1" },
  { slot: 2, light: "#f97316", dark: "#d1720f", varName: "--chart-2" },
  { slot: 3, light: "#14b8a6", dark: "#0d9488", varName: "--chart-3" },
  { slot: 4, light: "#7c3aed", dark: "#8b5cf6", varName: "--chart-4" },
  { slot: 5, light: "#e11d48", dark: "#f43f5e", varName: "--chart-5" },
] as const

export const CHART_SERIES_LIGHT: readonly [string, string, string, string, string] = [
  "#2563eb",
  "#f97316",
  "#14b8a6",
  "#7c3aed",
  "#e11d48",
] as const

export const CHART_SERIES_DARK: readonly [string, string, string, string, string] = [
  "#3b82f6",
  "#d1720f",
  "#0d9488",
  "#8b5cf6",
  "#f43f5e",
] as const

function slotAt(index: number): ChartSeriesSlot {
  const slot = CHART_SERIES_SLOTS[index]
  if (slot === undefined) {
    throw new RangeError(`Chart series slot ${index} out of range 0..${MAX_CHART_SERIES - 1}`)
  }
  return slot
}

/**
 * Hex for a 0-based series slot in the given mode. Throws out of range —
 * callers aggregate extras into "Other" instead of inventing hues.
 */
export function seriesColor(slotIndex: number, mode: ChartThemeMode = "light"): string {
  const slot = slotAt(slotIndex)
  return mode === "dark" ? slot.dark : slot.light
}

/**
 * Theme-aware paint reference for SVG `fill`/`stroke` style props, e.g.
 * `style={{ stroke: chartSeriesFill(0) }}`. Resolves to the light hex by
 * default and the dark hex under `.dark`. Always prefer this over
 * `seriesColor()` inside components so dark mode follows the palette.
 */
export function chartSeriesFill(slotIndex: number): string {
  return `var(${slotAt(slotIndex).varName})`
}

/**
 * CSS declaring `--chart-1` … `--chart-5` for light (`:root`) and dark
 * (`.dark`). Charts render this in a `<style>` tag; keep the values here as
 * the single source of truth and mirror them in `apps/web/app/globals.css`.
 */
export function chartTokensCss(): string {
  const light = CHART_SERIES_SLOTS.map((slot) => `${slot.varName}:${slot.light};`).join("")
  const dark = CHART_SERIES_SLOTS.map((slot) => `${slot.varName}:${slot.dark};`).join("")
  return `:root{${light}}.dark{${dark}}`
}
