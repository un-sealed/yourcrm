import { getClientEnv } from "./env"

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

/**
 * Typed API client pattern. All web <-> API traffic goes through here:
 * - base URL from validated env
 * - `x-request-id` on every call (correlates with API logs/audit)
 * - `{ error }` responses throw as ApiError
 * - `apiFetch` unwraps `{ data }` envelopes; `apiFetchRaw` returns bare
 *   JSON for unenveloped endpoints (e.g. `/health`).
 */
export async function apiFetchRaw<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { NEXT_PUBLIC_API_URL } = getClientEnv()
  const requestId = crypto.randomUUID()
  const res = await fetch(`${NEXT_PUBLIC_API_URL}${path}`, {
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
