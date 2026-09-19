import { websocket } from "hono/bun"
import { createApp } from "./app"
import { getEnv } from "./env"
import { subscribeAutomationDispatcher } from "./routes/modules/automation"
import { subscribeNotificationsRealtimeDispatcher } from "./routes/modules/notifications"

// Fail fast on invalid environment (never boot with bad/missing secrets).
const env = getEnv()
const app = createApp()
const port = env.API_PORT

// Connect the domain event bus to the workflow dispatcher exactly once, at
// boot. Route factories deliberately do not subscribe — see the automation
// route header.
subscribeAutomationDispatcher()
// Same pattern for the notifications realtime hub — see the notifications
// route header ("REALTIME") for the full seam description.
subscribeNotificationsRealtimeDispatcher()

Bun.serve({
  port,
  fetch: app.fetch,
  // `websocket` (from `hono/bun`) is the lifecycle handler `upgradeWebSocket`
  // needs at the Bun.serve level — required for `GET /api/v1/notifications/ws`.
  websocket,
  error(err) {
    console.error(JSON.stringify({ level: "error", msg: "server_error", err: String(err) }))
    return new Response("Internal server error", { status: 500 })
  },
})

console.log(`YourCRM API listening on http://localhost:${port}`)
