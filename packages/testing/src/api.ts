import type { Session } from "@yourcrm/auth"
import { errorEnvelopeSchema, type ErrorEnvelope } from "@yourcrm/validation"
import { nextId } from "./time"

/**
 * Header carrying the exact session fixture (base64url JSON). The
 * foundation `apps/api` auth hook (`x-dev-session: 1`, also sent) only
 * resolves the dev owner session until Phase-1 auth lands; module agents'
 * test apps should honor this header via `decodeTestSession()` so
 * role-specific API tests run against the exact fixture.
 */
export const TEST_SESSION_HEADER = "x-test-session"

/** Minimal surface a Hono app exposes for tests (`app.request(...)`). */
export type TestApp = {
  request: (
    input: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Response | Promise<Response>
}

/** Serialize a session fixture for `TEST_SESSION_HEADER`. */
export function encodeTestSession(session: Session): string {
  const bytes = new TextEncoder().encode(JSON.stringify(session))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

/** Parse a `TEST_SESSION_HEADER` value back into a session (or null). */
export function decodeTestSession(value: string | null | undefined): Session | null {
  if (!value) return null
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) ?? 0
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof parsed !== "object" || parsed === null || !("user" in parsed)) return null
    return parsed as Session
  } catch {
    return null
  }
}

export type ApiClientOptions = {
  app: TestApp
  /** Default session for every request (per-request `session` overrides). */
  session?: Session | null
  /** Default `x-request-id` (per-request `requestId` overrides). */
  requestId?: string
}

export type ApiRequestOptions = {
  session?: Session | null
  requestId?: string
  headers?: Record<string, string>
  /** Fail the request when the status differs. */
  expectedStatus?: number
}

export type ApiSuccessBody = {
  data: unknown
  pagination?: { nextCursor: string | null; limit: number }
}

export type ApiResponse = {
  status: number
  headers: Headers
  /** Echoed `x-request-id` response header. */
  requestId: string | null
  /** Parsed JSON body (or null when the body is empty / not JSON). */
  body: unknown
  /**
   * Assert the shared success envelope (`{ data, pagination? }`) and
   * return the body for further assertions.
   */
  expectSuccess: () => ApiSuccessBody
  /**
   * Assert the shared error envelope (`{ error: { code, message } }`),
   * optionally asserting the error `code`, and return it.
   */
  expectError: (expectedCode?: string) => ErrorEnvelope
}

export type ApiTestClient = {
  request: (
    path: string,
    init?: ApiRequestOptions & { method?: string; body?: string },
  ) => Promise<ApiResponse>
  get: (path: string, options?: ApiRequestOptions) => Promise<ApiResponse>
  post: (path: string, body?: unknown, options?: ApiRequestOptions) => Promise<ApiResponse>
  put: (path: string, body?: unknown, options?: ApiRequestOptions) => Promise<ApiResponse>
  patch: (path: string, body?: unknown, options?: ApiRequestOptions) => Promise<ApiResponse>
  delete: (path: string, options?: ApiRequestOptions) => Promise<ApiResponse>
}

function buildHeaders(
  session: Session | null | undefined,
  requestId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { "x-request-id": requestId, ...extra }
  if (session) {
    headers["x-dev-session"] = "1"
    headers[TEST_SESSION_HEADER] = encodeTestSession(session)
  }
  return headers
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function toApiResponse(res: Response, body: unknown): ApiResponse {
  const expectSuccess = (): ApiSuccessBody => {
    if (!isRecord(body) || !("data" in body)) {
      throw new Error(
        `expectSuccess: status ${res.status} body has no "data" — ${JSON.stringify(body)}`,
      )
    }
    if ("pagination" in body && body.pagination !== undefined) {
      const pagination = body.pagination
      if (
        !isRecord(pagination) ||
        !("nextCursor" in pagination) ||
        !("limit" in pagination) ||
        (pagination.nextCursor !== null && typeof pagination.nextCursor !== "string") ||
        typeof pagination.limit !== "number"
      ) {
        throw new Error(
          `expectSuccess: "pagination" must be { nextCursor, limit } — ${JSON.stringify(body)}`,
        )
      }
    }
    return body as ApiSuccessBody
  }
  const expectError = (expectedCode?: string): ErrorEnvelope => {
    const parsed = errorEnvelopeSchema.safeParse(body)
    if (!parsed.success) {
      throw new Error(
        `expectError: status ${res.status} body is not an error envelope — ${JSON.stringify(body)}`,
      )
    }
    if (expectedCode !== undefined && parsed.data.error.code !== expectedCode) {
      throw new Error(
        `expectError: expected code "${expectedCode}" but got "${parsed.data.error.code}"`,
      )
    }
    return parsed.data
  }
  return {
    status: res.status,
    headers: res.headers,
    requestId: res.headers.get("x-request-id"),
    body,
    expectSuccess,
    expectError,
  }
}

/**
 * Thin test client for Hono apps. Sends `x-request-id` on every request,
 * attaches the session fixture when present, and asserts the shared
 * envelope shapes from `@yourcrm/validation`.
 *
 * ```ts
 * const api = createApiClient({ app, session: makeSession({ role: "viewer" }) })
 * const res = await api.get("/api/v1/people")
 * const { data } = res.expectSuccess()
 * ;(await api.get("/api/v1/me")).expectError("UNAUTHORIZED")
 * ```
 */
export function createApiClient(options: ApiClientOptions): ApiTestClient {
  const run = async (
    path: string,
    method: string,
    body: string | undefined,
    opts: ApiRequestOptions = {},
  ): Promise<ApiResponse> => {
    const session = opts.session !== undefined ? opts.session : options.session
    const requestId = opts.requestId ?? options.requestId ?? nextId("req")
    const headers = buildHeaders(session, requestId, opts.headers)
    if (body !== undefined) headers["content-type"] = "application/json"
    const res = await options.app.request(path, { method, headers, body })
    let parsed: unknown = null
    try {
      parsed = await res.json()
    } catch {
      parsed = null
    }
    if (opts.expectedStatus !== undefined && res.status !== opts.expectedStatus) {
      throw new Error(
        `expected status ${opts.expectedStatus} but got ${res.status} — ${JSON.stringify(parsed)}`,
      )
    }
    return toApiResponse(res, parsed)
  }

  const withBody = (method: string) => (path: string, body?: unknown, opts?: ApiRequestOptions) =>
    run(path, method, body === undefined ? undefined : JSON.stringify(body), opts)

  return {
    request: (path, init) => run(path, init?.method ?? "GET", init?.body, init),
    get: (path, opts) => run(path, "GET", undefined, opts),
    post: withBody("POST"),
    put: withBody("PUT"),
    patch: withBody("PATCH"),
    delete: (path, opts) => run(path, "DELETE", undefined, opts),
  }
}
