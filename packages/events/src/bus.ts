import type { DomainEvent } from "./envelope"

export type EventHandler = (event: DomainEvent) => void | Promise<void>

/**
 * Minimal in-process bus for the foundation. Production fan-out goes
 * through Redis pub/sub + BullMQ jobs (see apps/worker); this interface
 * stays stable so domain code never imports Redis directly.
 */
export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>()
  private wildcard = new Set<EventHandler>()

  on(event: string | "*", handler: EventHandler): () => void {
    if (event === "*") {
      this.wildcard.add(handler)
      return () => {
        this.wildcard.delete(handler)
      }
    }
    const set = this.handlers.get(event) ?? new Set<EventHandler>()
    set.add(handler)
    this.handlers.set(event, set)
    return () => {
      set.delete(handler)
    }
  }

  async emit(event: DomainEvent): Promise<void> {
    const targets = [...(this.handlers.get(event.event) ?? []), ...this.wildcard]
    for (const handler of targets) {
      await handler(event)
    }
  }

  listenerCount(event?: string): number {
    if (event) return this.handlers.get(event)?.size ?? 0
    return this.wildcard.size
  }
}

let shared: EventBus | null = null

export function getEventBus(): EventBus {
  if (!shared) shared = new EventBus()
  return shared
}
