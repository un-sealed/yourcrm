import { AI_POLICY_WILDCARD, type AiActionType, type AiPolicyMode } from "./schemas"
import type { AiPolicyRecord } from "./types"

/**
 * Policy resolution — a PURE FUNCTION, deliberately.
 *
 * "Does this AI action need a human?" is the question the whole module
 * turns on, so it is answered by code with no database, no clock and no
 * I/O: the same function decides on the server, in the tests and (via the
 * API) in the UI preview.
 *
 * THE DEFAULT IS DENY-BY-HUMAN. An (object, action) pair with no matching
 * policy resolves to `require_approval`, never to `auto_apply`. A
 * workspace that has configured nothing therefore has a fully manual AI:
 * you opt IN to automation, one scope at a time.
 */

/** What an unmatched (object, action) pair means. Never `auto_apply`. */
export const AI_POLICY_DEFAULT_MODE: AiPolicyMode = "require_approval"

export type AiPolicyScope = {
  objectType: string
  action: AiActionType
}

export type AiPolicyResolution = {
  mode: AiPolicyMode
  /** The policy that decided, or `null` when the default did. */
  policyId: string | null
  /** Human-readable scope, e.g. `person:update` or `*:*` (default). */
  scope: string
}

function isPolicyMode(value: unknown): value is AiPolicyMode {
  return value === "require_approval" || value === "auto_apply" || value === "forbidden"
}

/**
 * How specific a policy is for a scope, or `-1` when it does not apply.
 *
 *   person:update  3   exact
 *   person:*       2   whole object
 *   *:update       1   one action everywhere
 *   *:*            0   workspace-wide fallback
 *
 * The most specific live policy wins. `ai_policies_scope_idx` makes each
 * scope unique per workspace, so there are never two candidates at the
 * same specificity.
 */
export function aiPolicySpecificity(policy: AiPolicyRecord, scope: AiPolicyScope): number {
  const objectMatches =
    policy.objectType === scope.objectType || policy.objectType === AI_POLICY_WILDCARD
  const actionMatches = policy.action === scope.action || policy.action === AI_POLICY_WILDCARD
  if (!objectMatches || !actionMatches) return -1
  return (
    (policy.objectType === AI_POLICY_WILDCARD ? 0 : 2) +
    (policy.action === AI_POLICY_WILDCARD ? 0 : 1)
  )
}

/**
 * Resolve the mode for one proposed action.
 *
 * Disabled and soft-deleted policies are ignored (the store only returns
 * live enabled rows; the `enabled === false` guard here means a stale
 * in-memory list cannot silently loosen the gate either). A policy whose
 * `mode` is not a known value is treated as absent rather than trusted —
 * an unreadable policy must not widen what AI may do.
 */
export function resolveAiPolicy(
  policies: readonly AiPolicyRecord[],
  scope: AiPolicyScope,
): AiPolicyResolution {
  let best: { policy: AiPolicyRecord; rank: number } | null = null
  for (const policy of policies) {
    if (policy.enabled === false) continue
    if (policy.deletedAt != null) continue
    if (!isPolicyMode(policy.mode)) continue
    const rank = aiPolicySpecificity(policy, scope)
    if (rank < 0) continue
    if (best === null || rank > best.rank) best = { policy, rank }
  }
  if (best === null) {
    return {
      mode: AI_POLICY_DEFAULT_MODE,
      policyId: null,
      scope: `${AI_POLICY_WILDCARD}:${AI_POLICY_WILDCARD}`,
    }
  }
  const mode = best.policy.mode
  return {
    mode: isPolicyMode(mode) ? mode : AI_POLICY_DEFAULT_MODE,
    policyId: best.policy.id,
    scope: `${best.policy.objectType}:${best.policy.action}`,
  }
}

/** Serialisable summary for the settings UI and the API catalogue. */
export function describeAiPolicyModes(): { mode: AiPolicyMode; label: string; detail: string }[] {
  return [
    {
      mode: "require_approval",
      label: "Needs approval",
      detail: "A person reviews the diff and approves or rejects it. The default for everything.",
    },
    {
      mode: "auto_apply",
      label: "Applies automatically",
      detail:
        "Skips the human, still checks the requesting actor's live permissions, still recorded and revertible.",
    },
    {
      mode: "forbidden",
      label: "Never",
      detail: "AI may not even propose this. The request is recorded and rejected immediately.",
    },
  ]
}
