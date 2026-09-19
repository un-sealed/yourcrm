import { describe, expect, test } from "bun:test"
import { ApiError, apiFetch, apiFetchRaw } from "./api-client"

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

describe("web/api-client", () => {
  test("unwraps { data } envelopes", async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () =>
      jsonResponse({ data: { pong: true } })) as unknown as typeof fetch
    try {
      await expect(apiFetch<{ pong: boolean }>("/api/v1/ping")).resolves.toEqual({ pong: true })
    } finally {
      globalThis.fetch = orig
    }
  })

  test("throws ApiError on { error } envelopes with request id", async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () =>
      jsonResponse({ error: { code: "UNAUTHORIZED", message: "nope" } }, 401, {
        "x-request-id": "req-123",
      })) as unknown as typeof fetch
    try {
      const err = await apiFetch("/api/v1/me").catch((e) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe("UNAUTHORIZED")
      expect((err as ApiError).requestId).toBe("req-123")
    } finally {
      globalThis.fetch = orig
    }
  })

  test("apiFetchRaw returns unenveloped JSON (e.g. /health)", async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () =>
      jsonResponse({ status: "ok", version: "0.1.0" })) as unknown as typeof fetch
    try {
      await expect(apiFetchRaw<{ status: string; version: string }>("/health")).resolves.toEqual({
        status: "ok",
        version: "0.1.0",
      })
    } finally {
      globalThis.fetch = orig
    }
  })

  test("apiFetch rejects a missing { data } envelope", async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () => jsonResponse({ status: "ok" })) as unknown as typeof fetch
    try {
      const err = await apiFetch("/health").catch((e) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe("BAD_ENVELOPE")
    } finally {
      globalThis.fetch = orig
    }
  })
})
