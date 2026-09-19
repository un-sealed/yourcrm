import { describe, expect, test } from "bun:test"
import { PermissionDeniedError, requirePermission } from "@yourcrm/permissions"
import { expectAllowed, expectDenied } from "./permissions"

const denyCtx = { workspaceId: "ws_1", actorId: "u_1", role: "viewer", action: "delete" } as const

describe("testing/permissions", () => {
  test("expectDenied passes only on PermissionDeniedError (sync and async)", async () => {
    const sync = await expectDenied(() => requirePermission({ ...denyCtx }))
    expect(sync).toBeInstanceOf(PermissionDeniedError)
    const asyncErr = await expectDenied(async () => requirePermission({ ...denyCtx }))
    expect(asyncErr.ctx.action).toBe("delete")
  })

  test("expectDenied fails when nothing throws", async () => {
    await expect(expectDenied(() => "ok")).rejects.toThrow("nothing was thrown")
    await expect(expectDenied(async () => "ok")).rejects.toThrow("nothing was thrown")
  })

  test("expectDenied fails on any other error (a typo must not pass)", async () => {
    await expect(
      expectDenied(() => {
        throw new TypeError("boom")
      }),
    ).rejects.toThrow("expected PermissionDeniedError but got TypeError: boom")
    await expect(expectDenied(async () => Promise.reject(new Error("nope")))).rejects.toThrow(
      "expected PermissionDeniedError but got Error: nope",
    )
  })

  test("expectAllowed returns the value", async () => {
    expect(await expectAllowed(() => 42)).toBe(42)
    expect(await expectAllowed(async () => ({ ok: true }))).toEqual({ ok: true })
  })

  test("expectAllowed fails clearly on denial and passes other errors through", async () => {
    await expect(expectAllowed(() => requirePermission({ ...denyCtx }))).rejects.toThrow(
      "call was denied",
    )
    const original = new RangeError("real bug")
    await expect(expectAllowed(() => Promise.reject(original))).rejects.toBe(original)
  })
})
