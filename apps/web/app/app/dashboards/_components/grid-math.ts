import { GRID_COLUMNS } from "../types"

/**
 * Pure grid math for the widget layout: no DOM, no React, so it is cheap to
 * unit test independently of the drag/drop wiring in `widget-grid.tsx`.
 */

export type GridCell = { x: number; y: number }

/** Keep a widget's top-left corner on the grid and its span in-bounds. */
export function clampCell(cell: GridCell, width: number, columns: number = GRID_COLUMNS): GridCell {
  const maxX = Math.max(0, columns - width)
  return {
    x: Math.min(Math.max(0, Math.round(cell.x)), maxX),
    y: Math.max(0, Math.round(cell.y)),
  }
}

/**
 * Translate a drop point (relative to the grid container) into a grid cell.
 * `rect` is the container's bounding box; `rowHeightPx` is the fixed row
 * height used by the CSS grid (`gridAutoRows`).
 */
export function pointToCell(
  point: { clientX: number; clientY: number },
  rect: { left: number; top: number; width: number },
  rowHeightPx: number,
  columns: number = GRID_COLUMNS,
): GridCell {
  const colWidth = rect.width / columns
  const x = colWidth > 0 ? Math.floor((point.clientX - rect.left) / colWidth) : 0
  const y = rowHeightPx > 0 ? Math.floor((point.clientY - rect.top) / rowHeightPx) : 0
  return { x, y }
}

/** The first free row below every existing widget (server mirrors this). */
export function stackBottom(widgets: { positionY: number; height: number }[]): number {
  return widgets.reduce((max, w) => Math.max(max, w.positionY + w.height), 0)
}

/** Largest value in a widget's series, floored at 1 so a chart never divides by zero. */
export function seriesMax(series: { value: number }[]): number {
  return Math.max(1, ...series.map((s) => s.value))
}
