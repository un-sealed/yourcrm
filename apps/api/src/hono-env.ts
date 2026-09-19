import type { Session } from "@yourcrm/auth"

/** Shared Hono context variables (request id, session). */
export type AppEnv = {
  Variables: {
    requestId: string
    session: Session | null
  }
}
