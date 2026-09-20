/**
 * Categorical series palette for dashboard charts (spec §1).
 *
 * Fixed slot order, never cycled: assign slots in order and fold a 6th
 * series into "Other" — never generate a hue. Colour follows the entity,
 * never its rank, so filtering a series out must not repaint the survivors
 * (keep each entity pinned to its slot index).
 *
 * Dark mode uses the selected dark column below — never a CSS filter flip.
 * Components consume the palette through `var(--chart-N)` custom properties
 * (see {@link chartTokensCss}); `chartSeriesColor` exposes the raw columns
 * for canvas/SSR fallbacks and tests.
 */

export const CHART_SERIES_LIGHT = ["#2563eb", "#f97316", "#14b8a6", "#7c3aed", "#e11d48"] as const

export const CHART_SERIES_DARK = ["#3b82f6", "#d1720f", "#0d9488", "#8b5cf6", "#f43f5e"] as const

/** Number of fixed palette slots. Entities past this fold into "Other". */
export const CHART_SERIES_SLOT_COUNT = CHART_SERIES_LIGHT.length

/** Aggregate bucket for series past the last fixed slot — never a new hue. */
export const OTHER_SERIES_LABEL = "Other"

export type ChartMode = "light" | "dark"

/** CSS custom property name for a 0-based palette slot, e.g. `--chart-1`. */
export function chartSeriesVar(slot: number): string {
  return `--chart-${slot + 1}`
}

/**
 * Raw hex for a 0-based palette slot in the given mode.
 * Throws for out-of-range slots: callers must fold extras into "Other"
 * instead of inventing a colour.
 */
export function chartSeriesColor(slot: number, mode: ChartMode): string {
  const column = mode === "dark" ? CHART_SERIES_DARK : CHART_SERIES_LIGHT
  const color: string | undefined = column[slot]
  if (color === undefined) {
    throw new RangeError(
      `chartSeriesColor: slot ${slot} is outside the fixed palette ` +
        `(0-${CHART_SERIES_SLOT_COUNT - 1}); fold extra series into "${OTHER_SERIES_LABEL}"`,
    )
  }
  return color
}

function slotDeclarations(colors: readonly string[], mutedBar: string): string {
  const slots = colors.map((color, index) => `${chartSeriesVar(index)}:${color}`).join(";")
  return `${slots};--chart-muted-bar:${mutedBar}`
}

/**
 * Stylesheet text defining `--chart-1…5` (light default, `.dark` selected
 * column) plus `--chart-muted-bar` (bar de-emphasis: `--border-strong` in
 * light, `--surface-2` in dark). Each chart component renders this in a
 * `<style>` tag so the palette works without any app-shell setup.
 */
export const chartTokensCss =
  `:root{${slotDeclarations(CHART_SERIES_LIGHT, "var(--border-strong)")}}` +
  `.dark{${slotDeclarations(CHART_SERIES_DARK, "var(--surface-2)")}}`
