import { PermissionDeniedError } from "@yourcrm/permissions"

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

/**
 * Assert a service call is denied. Passes only when `fn` throws (or rejects
 * with) the real `PermissionDeniedError` from `@yourcrm/permissions` —
 * any other throw, or no throw, fails the test. Returns the error so tests
 * can assert on its context.
 *
 * ```ts
 * await expectDenied(() => service.update(ctx, id, patch))
 * ```
 */
export async function expectDenied(
  fn: () => unknown | Promise<unknown>,
): Promise<PermissionDeniedError> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof PermissionDeniedError) return err
    throw new Error(`expectDenied: expected PermissionDeniedError but got ${describeError(err)}`)
  }
  throw new Error("expectDenied: expected PermissionDeniedError but nothing was thrown")
}

/**
 * Assert a service call is allowed. Returns the resolved value for further
 * assertions. A `PermissionDeniedError` fails with a clear message; any
 * other error propagates untouched.
 *
 * ```ts
 * const rows = await expectAllowed(() => service.list(ctx))
 * ```
 */
export async function expectAllowed<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      throw new Error(`expectAllowed: call was denied — ${describeError(err)}`)
    }
    throw err
  }
}
