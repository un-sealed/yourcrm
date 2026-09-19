import { createMiddleware } from "hono/factory"
import type { AppEnv } from "../hono-env"

/** Structured request logging: method, path, status, duration, request id. */
export function logger() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const start = Date.now()
    await next()
    const ms = Date.now() - start
    const record = {
      level: "info",
      msg: "http_request",
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: ms,
      requestId: c.get("requestId") ?? undefined,
    }
    console.log(JSON.stringify(record))
  })
}
