import type { WebhookTransportPort } from "./types"

/**
 * Default transport: one HTTPS POST, no cleverness.
 *
 * It lives beside the service rather than in `apps/*` because both the API
 * (manual replay) and the worker (queued delivery) need the same one, and
 * because the two behaviours below are SECURITY decisions, not transport
 * details — they belong with the guard that motivates them:
 *
 *  - `redirect: "manual"`. A 3xx is returned to the caller as a status
 *    code and classified as permanent. Following redirects would let a
 *    subscriber bounce a signed payload to `http://169.254.169.254/`,
 *    which the SSRF guard just refused — the guard vets the URL we chose,
 *    not one the subscriber chooses afterwards.
 *  - a hard timeout. Without it a subscriber that accepts a connection and
 *    never answers holds a worker slot indefinitely, which is a free
 *    denial of service against the whole queue.
 *
 * It uses the platform `fetch`, so it adds no dependency. A deployment
 * that needs address pinning (see the TOCTOU note in url-guard.ts) swaps
 * in its own `WebhookTransportPort` and uses `request.resolvedAddresses`;
 * nothing else changes.
 */
export function createFetchWebhookTransport(fetchImpl: typeof fetch = fetch): WebhookTransportPort {
  return async (request) => {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(request.timeoutMs),
    })
    // Read at most what we are willing to store, then stop: a subscriber
    // must not be able to stream a gigabyte into an error column.
    const text = await response.text().catch(() => "")
    return { statusCode: response.status, bodySnippet: text.slice(0, 1024) }
  }
}
