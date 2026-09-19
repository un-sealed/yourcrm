# 03 — Security & Authentication

The authentication architecture is well-designed: httpOnly session cookie
(`yourcrm_session`), tokens stored only as SHA-256 hashes, timing-safe
comparison, login rate limiters, generic failure messages, and a single
`requirePermission()` policy used identically by browser sessions, API keys and
AI actions. The findings below are about **configuration defaults and
misconfiguration footguns**, not the design.

## 3.1 CRITICAL — `x-dev-session` bypass is armed by a missing `NODE_ENV`

`apps/api/src/middleware/auth.ts:138`:

```ts
if (!session && env !== "production" && c.req.header("x-dev-session") === "1") {
  session = devSession()   // a full OWNER session
}
```

`packages/config/src/env.ts` declares:

```ts
NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
```

**Impact.** A production deployment that does not set `NODE_ENV=production`
silently enables an unauthenticated, full-owner session for anyone who sends
the header `x-dev-session: 1`. That is a complete authentication bypass,
reachable by a single HTTP header. Because `NODE_ENV` defaults to
`development`, this is a realistic operator mistake — and the failure is
silent (no warning is logged).

**Fix (pick one, do both ideally):**
1. Gate the bypass on an explicit, default-off opt-in — e.g.
   `ALLOW_DEV_SESSION=1` — instead of `NODE_ENV !== "production"`. Absence of
   the positive flag disables it everywhere.
2. Make `NODE_ENV` required (no default) so the app refuses to boot when it is
   not explicit. Log a warning at startup whenever the bypass is enabled.

## 3.2 CRITICAL — insecure default secrets let the app boot in production

`packages/config/src/env.ts`:

```ts
SESSION_SECRET: z.string().min(32).default("x".repeat(64)),
ENCRYPTION_KEY: z.string().min(32).default("y".repeat(64)),
```

These defaults are **publicly-known constants**. The README claims the app
"refuses to boot on invalid config", but a deployed app missing these vars
boots happily with known values.

- `ENCRYPTION_KEY` is the AES-256-GCM key that seals **integration provider
  credentials** and **webhook signing secrets**
  (`packages/database/src/repositories/integrations-repository.ts:59`,
  `api-webhooks-repository.ts:30`). With the default key, anyone with database
  access can decrypt every stored provider secret and forge webhook
  signatures.
- `SESSION_SECRET` is **not actually used anywhere** in the codebase (see 3.4),
  so the default is inert — but the misleading requirement remains.

**Fix:** in `envSchema`, make `SESSION_SECRET` and `ENCRYPTION_KEY` required
(`z.string().min(32)`) with **no default**, or default them to a sentinel and
reject the sentinel when `NODE_ENV === "production"`. Add a config unit test
proving a production boot with default/absent secrets throws. `docker-compose.prod.yml`
already passes both through as required env vars, so the fix aligns with the
deployment manifest.

## 3.3 HIGH — public API-key authentication is not mounted

(Also listed as `02.4`.) `apps/api/src/lib/api-key-auth.ts` and
`resolvePublicApiKey` exist and are tested, but `apps/api/src/app.ts` never
mounts `publicApiKeyAuth`. Public API keys authenticate nothing today. The
design (single `Session` shape, no parallel policy, never overwrites an
existing session) is sound; only the one-line mount is missing.

**Doc/API mismatch (LOW)** — while there: the middleware's own JSDoc says
`app.use("*", publicApiKeyAuth())` with no argument, but the implementation
requires `{ resolve }`. The correct call is:
```ts
app.use("*", publicApiKeyAuth({ resolve: resolvePublicApiKey }))
```

## 3.4 MEDIUM — `SESSION_SECRET` is declared, documented and defaulted, but unused

`SESSION_SECRET` appears only in `packages/config/src/env.ts`, the CI/e2e
env, the prod compose manifest, and the docs. Session tokens are generated with
`randomBytes` and stored as plain `sha256` hashes
(`packages/auth/src/tokens.ts`), which does not consume a secret. So operators
are asked for a secret that does nothing.

**Fix:** either (a) remove `SESSION_SECRET` from the schema/docs and simplify
the deployment manifest, or (b) actually use it — e.g. HMAC the session token
or sign the cookie. Decide and document; do not leave a phantom requirement.

## 3.5 MEDIUM — CORS always allows localhost

`apps/api/src/app.ts` builds the allowlist from `APP_URL` plus hard-coded
`http://localhost:3000` and `http://127.0.0.1:3000`, in every environment:

```ts
const origins = Array.from(new Set([env.APP_URL, "http://localhost:3000", "http://127.0.0.1:3000"]))
```

**Impact.** Low in practice (those origins must resolve to an attacker's page),
but a production API should not trust localhost origins. Combined with
`credentials: true`, a local service on the operator's machine could make
credentialed cross-origin calls.

**Fix:** only append the localhost origins when `NODE_ENV !== "production"`.

## 3.6 MEDIUM — SSRF residual TOCTOU in webhook delivery

`packages/crm/src/api-webhooks/url-guard.ts` re-resolves and vets target
addresses before each attempt, but the default `fetch` transport connects by
**hostname**, so a malicious DNS resolver can answer differently between the
check and the connect. The guard hands vetted addresses to the transport
(`WebhookTransportRequest.resolvedAddresses`) so a hardened transport could
pin them; the default cannot. Closing it needs a custom agent/dispatcher
(a new dependency). This is documented, not hidden — flagged here because it
is a real, if narrow, SSRF window on an outbound feature.

## 3.7 MEDIUM — email HTML sanitizer is regex-based

`packages/crm/src/email/sanitize.ts` sanitizes HTML with regexes. Acceptable
while P0 renders plain text only, but it must become a real sanitizer
(`dompurify` / `sanitize-html`) before any rich-HTML view ships. Both the
email detail page and knowledge-base detail page explicitly avoid
`dangerouslySetInnerHTML` today, which is the right mitigation in the meantime.

## 3.8 INFO — verified-good security properties

- Session cookie is `httpOnly`, `SameSite=Lax`, and `Secure` in production
  (`packages/auth/src/cookies.ts`, proven by `service.test.ts:220`).
- Session tokens are random (`randomBytes`), never stored in plaintext, and
  compared with `timingSafeEqual`.
- Login has rate limiters and generic failure messages (no user enumeration).
- `requirePermission()` is called first in every domain service method
  (verified across all `packages/crm/src/**/*service*.ts` — the sole exception
  is `marketing/batch-service.ts`, which is a worker-triggered system action
  with no session; it is intentionally ungated and documented as such).
- API keys map onto the same `Session` shape, so there is no second
  authorization path to drift out of step.
- `.env` is gitignored and untracked (verified with `git ls-files`).
- Audit rows are append-only at the database level (a trigger in
  `0320_settings.sql` rejects UPDATE/DELETE/TRUNCATE).
- `x-dev-session` is not accepted in production *when `NODE_ENV` is correct*
  (see 3.1 for the caveat).

## 3.9 Out-of-band follow-ups (from repo docs, still valid)

- **Rotate the agentrouter API key** — it was pasted into a chat transcript.
  It currently lives only in the gitignored `.env`.
- **Human security review** is still outstanding on credential encryption
  (`integrations`), webhook signature verification, the `reports` SQL
  allowlist, automation permission inheritance, and customer-portal scope
  containment. Agents proved their own designs correct; that is not the same
  as an independent check that the designs are right.

## Summary

| # | Severity | Item |
| --- | --- | --- |
| 3.1 | CRITICAL | `x-dev-session` owner bypass if `NODE_ENV` is unset (it defaults to dev) |
| 3.2 | CRITICAL | Known default `ENCRYPTION_KEY` seals real secrets in prod |
| 3.3 | HIGH | Public API-key auth not mounted (+ JSDoc/impl mismatch) |
| 3.4 | MEDIUM | `SESSION_SECRET` required/documented but unused |
| 3.5 | MEDIUM | CORS trusts localhost origins in every environment |
| 3.6 | MEDIUM | SSRF residual TOCTOU in webhook delivery |
| 3.7 | MEDIUM | Regex-based HTML sanitizer |
| 3.8 | INFO | Core auth/security properties verified good |
| 3.9 | MEDIUM | Key rotation + independent security review outstanding |
