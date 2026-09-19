import type { Context } from "hono"
import type { AppEnv } from "../hono-env"
import { errorEnvelope } from "@yourcrm/validation"

/** Centralized error shape. All errors leave the API in this envelope. */
export function notFound(c: Context<AppEnv>) {
  return c.json(
    errorEnvelope("NOT_FOUND", `No route for ${c.req.method} ${c.req.path}`, requestIdOf(c)),
    404,
  )
}

export function internalError(c: Context, err: unknown) {
  console.error(
    JSON.stringify({
      level: "error",
      msg: "unhandled_error",
      requestId: requestIdOf(c),
      err: String(err),
    }),
  )
  const message = process.env.NODE_ENV === "production" ? "Internal server error" : String(err)
  return c.json(errorEnvelope("INTERNAL_ERROR", message, requestIdOf(c)), 500)
}

function requestIdOf(c: Context<AppEnv>): string | undefined {
  try {
    return (c.get as (k: string) => string | undefined)("requestId")
  } catch {
    return undefined
  }
}
