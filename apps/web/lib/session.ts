import { cookies } from "next/headers"
import { redirect } from "next/navigation"

/**
 * Wave-1 auth session helpers for server components (spec 04).
 * The web app never touches the database: it forwards its session cookie
 * to the API (`GET /api/v1/me`) and trusts the `{ data }` envelope.
 * No `@yourcrm/*` imports here by design (see `docs/architecture.md`).
 */

export const SESSION_COOKIE_NAME = "yourcrm_session"

export type WebSession = {
  user: { id: string; email: string; name?: string }
  workspaceId?: string
}

function apiBaseUrl(): string {
  return process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"
}

/** Current session or null (unknown/expired/revoked sessions are null). */
export async function getSession(): Promise<WebSession | null> {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE_NAME)?.value
  if (!token) return null
  try {
    const res = await fetch(`${apiBaseUrl()}/api/v1/me`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` },
      cache: "no-store",
    })
    if (!res.ok) return null
    const body = (await res.json()) as { data: WebSession }
    if (!body?.data?.user) return null
    return body.data
  } catch {
    return null
  }
}

/** Guard for server components/layouts: redirects to login when signed out. */
export async function requireSessionUser(redirectTo = "/login"): Promise<WebSession> {
  const session = await getSession()
  if (!session) redirect(redirectTo)
  return session
}
