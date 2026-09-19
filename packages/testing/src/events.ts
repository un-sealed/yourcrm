import { getEventBus, type DomainEvent, type EventBus } from "@yourcrm/events"

export type EventMatch = Partial<
  Pick<DomainEvent, "workspaceId" | "actorId" | "entityType" | "entityId" | "correlationId">
> & {
  /** Deep-compared (JSON) against the emitted `after` payload. */
  after?: unknown
  /** Deep-compared (JSON) against the emitted `before` payload. */
  before?: unknown
}

function matches(event: DomainEvent, match: EventMatch): boolean {
  const keys: (keyof EventMatch)[] = [
    "workspaceId",
    "actorId",
    "entityType",
    "entityId",
    "correlationId",
  ]
  for (const key of keys) {
    if (match[key] !== undefined && event[key] !== match[key]) return false
  }
  if (match.after !== undefined && JSON.stringify(event.after) !== JSON.stringify(match.after)) {
    return false
  }
  if (match.before !== undefined && JSON.stringify(event.before) !== JSON.stringify(match.before)) {
    return false
  }
  return true
}

export type CapturedEvents = {
  /** Every event captured since `captureEvents()` (or `clear()`), in order. */
  events: DomainEvent[]
  /** Number of captured events, optionally filtered by event name. */
  count: (event?: string) => number
  /**
   * Return the first captured event with this name matching `match`.
   * Throws a descriptive error when nothing matches — the failure names
   * the missing event instead of a bare "undefined".
   */
  expectEmitted: (event: string, match?: EventMatch) => DomainEvent
  /** Forget captured events (keeps listening). */
  clear: () => void
  /** Unsubscribe from the bus. Call this (typically in `afterEach`). */
  release: () => void
}

/**
 * Capture events from the in-process `EventBus` so tests prove they emit
 * domain events in one line:
 *
 * ```ts
 * const events = captureEvents()
 * try {
 *   await service.create(ctx, input)
 *   events.expectEmitted("person.created", { entityId: id })
 * } finally {
 *   events.release()
 * }
 * ```
 *
 * Pass an explicit bus to isolate a test from the shared singleton.
 */
export function captureEvents(bus: EventBus = getEventBus()): CapturedEvents {
  const captured: DomainEvent[] = []
  const unsubscribe = bus.on("*", (event) => {
    captured.push(event)
  })
  return {
    events: captured,
    count: (event?: string) =>
      event === undefined ? captured.length : captured.filter((e) => e.event === event).length,
    expectEmitted: (event: string, match: EventMatch = {}) => {
      const found = captured.find((e) => e.event === event && matches(e, match))
      if (!found) {
        const seen = captured.length === 0 ? "none" : captured.map((e) => e.event).join(", ")
        throw new Error(
          `expectEmitted: no "${event}" event captured matching ${JSON.stringify(match)} (saw: ${seen})`,
        )
      }
      return found
    },
    clear: () => {
      captured.length = 0
    },
    release: () => {
      unsubscribe()
    },
  }
}
