import { getClientEnv } from "./env"
import { isOffline } from "./offline"

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export type ApiOptions = {
  method?: string
  body?: unknown
  /** Session bearer token (Phase 1 auth). */
  token?: string
  signal?: AbortSignal
}

const SAFE_METHODS = new Set(["GET", "HEAD"])

/**
 * Typed API client pattern. All web <-> API traffic goes through here:
 * - base URL from validated env
 * - `x-request-id` on every call (correlates with API logs/audit)
 * - `{ error }` responses throw as ApiError
 * - `apiFetch` unwraps `{ data }` envelopes; `apiFetchRaw` returns bare
 *   JSON for unenveloped endpoints (e.g. `/health`).
 *
 * Offline writes: a mutating call (anything but GET/HEAD) made while
 * `navigator.onLine` is false is refused immediately, before it ever
 * reaches `fetch`, as `ApiError("OFFLINE", ...)`. This module chose
 * "refuse with a clear message" over "queue and replay" — queuing a CRM
 * write for later means either re-validating it against server state that
 * may have changed (a conflict-resolution engine the spec explicitly
 * scopes to P2 "offline/native", not this P0 pass) or risking a silent
 * stale write, which is the one thing this module is required not to do.
 * Refusing is the safe default: the caller sees the same ApiError path it
 * already handles for any other failed write (toast / inline error), the
 * user knows immediately nothing was saved, and no state can silently
 * diverge from the server. GET/HEAD reads are unaffected — they still hit
 * the network and fail with a normal network error if unreachable, same
 * as before this change.
 */
export async function apiFetchRaw<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method ?? "GET"
  if (!SAFE_METHODS.has(method) && isOffline()) {
    throw new ApiError(
      "OFFLINE",
      "You're offline, so this change wasn't saved. Reconnect and try again.",
      0,
    )
  }
  const { NEXT_PUBLIC_API_URL } = getClientEnv()
  const requestId = crypto.randomUUID()
  const res = await fetch(`${NEXT_PUBLIC_API_URL}${path}`, {
    // Auth is an httpOnly session cookie on a different origin (:3000 -> :4000),
    // so every request must opt in to sending it. Without this the cookie is
    // set at login and then never sent again, and every page 401s.
    credentials: "include",
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  })

  const requestIdHeader = res.headers.get("x-request-id") ?? requestId
  const json = (await res.json().catch(() => null)) as
    | T
    | { error: { code: string; message: string } }
    | null

  if (!res.ok || !json || (typeof json === "object" && "error" in json)) {
    const err =
      json && typeof json === "object" && "error" in json
        ? json.error
        : { code: "REQUEST_FAILED", message: res.statusText }
    throw new ApiError(err.code, err.message, res.status, requestIdHeader)
  }
  return json as T
}

export async function apiFetch<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const envelope = await apiFetchRaw<{ data: T }>(path, opts)
  if (!envelope || typeof envelope !== "object" || !("data" in envelope)) {
    throw new ApiError("BAD_ENVELOPE", `Expected { data } envelope from ${path}`, 200)
  }
  return envelope.data
}

export type HealthResponse = {
  status: "ok" | "degraded"
  version: string
  checks: Record<string, { ok: boolean }>
}

export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  // /health is intentionally unenveloped (load-balancer friendly).
  return apiFetchRaw<HealthResponse>("/health", { signal })
}
