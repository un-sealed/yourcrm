import { describe, expect, test } from "bun:test"
import { clampCell, pointToCell, seriesMax, stackBottom } from "./grid-math"

describe("dashboards/grid-math", () => {
  test("clampCell keeps a widget's span within the column count", () => {
    expect(clampCell({ x: 20, y: 3 }, 4, 12)).toEqual({ x: 8, y: 3 })
    expect(clampCell({ x: -5, y: -2 }, 4, 12)).toEqual({ x: 0, y: 0 })
    expect(clampCell({ x: 3, y: 1 }, 4, 12)).toEqual({ x: 3, y: 1 })
  })

  test("clampCell rounds fractional positions", () => {
    expect(clampCell({ x: 2.6, y: 1.2 }, 2, 12)).toEqual({ x: 3, y: 1 })
  })

  test("pointToCell converts a client point into a grid cell", () => {
    const rect = { left: 0, top: 0, width: 1200 }
    expect(pointToCell({ clientX: 150, clientY: 90 }, rect, 80, 12)).toEqual({ x: 1, y: 1 })
    expect(pointToCell({ clientX: 0, clientY: 0 }, rect, 80, 12)).toEqual({ x: 0, y: 0 })
  })

  test("pointToCell tolerates a zero-width container", () => {
    expect(pointToCell({ clientX: 50, clientY: 50 }, { left: 0, top: 0, width: 0 }, 80)).toEqual({
      x: 0,
      y: 0,
    })
  })

  test("stackBottom finds the first free row below existing widgets", () => {
    expect(stackBottom([])).toBe(0)
    expect(
      stackBottom([
        { positionY: 0, height: 2 },
        { positionY: 2, height: 3 },
      ]),
    ).toBe(5)
  })

  test("seriesMax floors at 1 so charts never divide by zero", () => {
    expect(seriesMax([])).toBe(1)
    expect(seriesMax([{ value: 0 }, { value: 0 }])).toBe(1)
    expect(seriesMax([{ value: 3 }, { value: 9 }, { value: 5 }])).toBe(9)
  })
})
