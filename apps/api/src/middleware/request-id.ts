import { createMiddleware } from "hono/factory"
import type { AppEnv } from "../hono-env"

export type AppVars = {
  requestId: string
}

/**
 * Request/correlation ID. Every response carries `x-request-id`; every log
 * line and audit row downstream uses it (spec 00 cross-cutting reqs).
 */
export function requestId() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const incoming = c.req.header("x-request-id")?.trim()
    const id = incoming && incoming.length <= 128 ? incoming : crypto.randomUUID()
    c.set("requestId", id)
    c.header("x-request-id", id)
    await next()
  })
}
