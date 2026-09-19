/**
 * In-process WebSocket fan-out hub (spec 43-notifications /
 * `docs/architecture.md` "Realtime": `workspace:<id>` channels land with
 * this module).
 *
 * Deliberately framework-light: a channel is just a name, a subscriber is
 * anything with `.send(string)`. `apps/api/src/routes/modules/notifications.ts`
 * is the only caller that hands it real `hono/ws` `WSContext` sockets (via
 * `upgradeWebSocket` from `hono/bun` — already a transitive dependency of
 * `hono`, so this ships with NO new package). That keeps this file
 * hermetically testable with a fake `{ send() {} }` object, no live server.
 *
 * SCALING SEAM: this hub is single-process. A second API instance would not
 * see another instance's publishes. `docs/architecture.md` already reserves
 * Redis/BullMQ as the fan-out layer for background jobs; the same
 * `sql: notifications:workspace:<id>` Redis pub/sub channel is the natural
 * extension point here — swap `publishToChannel`'s body for a Redis
 * `PUBLISH` and have every instance `SUBSCRIBE` and re-publish locally.
 * Until then, one API process is the documented limit.
 */

export type RealtimeClient = {
  send(data: string): void
}

const channels = new Map<string, Set<RealtimeClient>>()

export function workspaceChannel(workspaceId: string): string {
  return `workspace:${workspaceId}`
}

/** Join a channel. Returns the unsubscribe function — always call it on socket close. */
export function joinChannel(channel: string, client: RealtimeClient): () => void {
  const subscribers = channels.get(channel) ?? new Set<RealtimeClient>()
  subscribers.add(client)
  channels.set(channel, subscribers)
  return () => {
    subscribers.delete(client)
    if (subscribers.size === 0) channels.delete(channel)
  }
}

/** Best-effort fan-out: a subscriber whose `send` throws (dead socket) is skipped, not fatal. */
export function publishToChannel(channel: string, payload: unknown): void {
  const subscribers = channels.get(channel)
  if (!subscribers || subscribers.size === 0) return
  const message = JSON.stringify(payload)
  for (const client of subscribers) {
    try {
      client.send(message)
    } catch {
      // Cleanup happens via the socket's own close handler, not here.
    }
  }
}

export function channelSize(channel: string): number {
  return channels.get(channel)?.size ?? 0
}

/** Test-only: forget every channel/subscriber (this module holds process-wide singleton state). */
export function resetRealtimeHub(): void {
  channels.clear()
}
