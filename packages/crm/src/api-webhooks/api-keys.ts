import { randomBytes } from "node:crypto"
import { checkPermission, PERMISSION_ACTIONS } from "@yourcrm/permissions"

/**
 * Public API keys: generation, shape, and the "never exceed the creator"
 * rule (spec 32 §8).
 *
 * WHY HASHED, NOT ENCRYPTED. A webhook signing secret must be reproducible
 * — the server has to recompute an HMAC with it — so it is sealed with
 * AES-256-GCM and can be opened. An API key never needs to be reproduced:
 * the server only has to RECOGNISE one the caller presents. Hashing is
 * therefore strictly stronger here, and it makes "cannot be read back" a
 * property of the storage rather than of a redaction step somebody has to
 * remember. The hash itself is computed in the repository, beside the
 * cipher, because it is a persistence concern.
 *
 * A plain SHA-256 (no slow KDF) is correct for this input: the key is 32
 * CSPRNG bytes, so there is no password-shaped guessing attack to slow
 * down — the same reasoning `@yourcrm/auth`'s `hashSessionToken` records
 * for session tokens.
 */

export const PUBLIC_API_KEY_PREFIX = "ycrm_sk"

export const PUBLIC_API_KEY_BYTES = 32

/** `ycrm_sk_` + 43 base64url characters. */
const PUBLIC_API_KEY_PATTERN = /^ycrm_sk_[A-Za-z0-9_-]{20,128}$/

/**
 * Mint a key. Returned to the creator exactly once; only its hash is
 * persisted. The `ycrm_sk_` prefix exists so secret scanners (GitHub push
 * protection, gitleaks) can recognise a leaked key on sight.
 */
export function generatePublicApiKey(): string {
  return `${PUBLIC_API_KEY_PREFIX}_${randomBytes(PUBLIC_API_KEY_BYTES).toString("base64url")}`
}

/**
 * Cheap shape check before touching the database. An `Authorization:
 * Bearer <session-token>` header must not cost an API-key lookup, and a
 * garbage header must not cost anything at all.
 */
export function looksLikePublicApiKey(value: string): boolean {
  return PUBLIC_API_KEY_PATTERN.test(value)
}

/** Non-secret display tail. Four characters reveal nothing useful. */
export function publicApiKeyLastFour(rawKey: string): string {
  return rawKey.slice(-4)
}

/**
 * Does `candidate` grant anything `ceiling` does not?
 *
 * Derived from the shared policy rather than from a second copy of the
 * role ranking: for every action in `PERMISSION_ACTIONS`, a key's role may
 * only be allowed where its creator's role is also allowed. If
 * `@yourcrm/permissions` changes its model — adds an action, re-ranks a
 * role — this follows automatically, because there is no local table to
 * forget to update.
 */
export function roleExceedsCeiling(candidate: string, ceiling: string): boolean {
  const probe = { workspaceId: "role-probe", actorId: "role-probe" }
  return PERMISSION_ACTIONS.some(
    (action) =>
      checkPermission({ ...probe, role: candidate, action }).allowed &&
      !checkPermission({ ...probe, role: ceiling, action }).allowed,
  )
}
