# `@yourcrm/auth`

Wave-1 authentication boundary (specs `04-authentication`,
`05-users-teams-permissions`). Email + password only — no OAuth, SAML,
OIDC, or magic links (later phases).

## Contracts

- `src/session.ts` — the stable `Session` contract (`user`, `memberships`,
  `workspaceId`, `expiresAt`) plus `requireWorkspace()`,
  `roleInWorkspace()`, `devSession()`. **The shape is frozen**: the
  permissions package and every future service depend on it.
- `src/service.ts` — `signupUser()`, `loginUser()`, `logoutUser()`,
  `resolveSession()` against the `AuthStore` port (`src/store.ts`).
- `src/schemas.ts` — `signupSchema` / `loginSchema` (zod). The
  platform-seams agent mounts these on the HTTP endpoints below.
- `src/cookies.ts` — `yourcrm_session` cookie helpers (httpOnly, Secure,
  SameSite=Lax). Raw tokens are never stored — only their SHA-256 hash.
- `src/password.ts`, `src/tokens.ts`, `src/rate-limit.ts` — argon2id via
  `Bun.password`, 32-byte CSPRNG tokens, per-IP + per-account limiters.
- `src/memory-store.ts` — hermetic `AuthStore` for tests.

## HTTP contract (platform-seams agent mounts these)

- `POST /api/v1/auth/signup` `{name, email, password, workspaceName?}` →
  201 + `Set-Cookie`. 409 `EMAIL_TAKEN`.
- `POST /api/v1/auth/login` `{email, password}` → 200 + `Set-Cookie`
  (fresh token every login: fixation-safe). Failures are generic 401
  `INVALID_CREDENTIALS`; brute force yields 429 `RATE_LIMITED`.
- `POST /api/v1/auth/logout` → 200, revokes server-side, clears cookie.
- `GET /api/v1/me` — resolved by `apps/api/src/middleware/auth.ts`
  (cookie or `Authorization: Bearer`), expiry/revocation enforced
  server-side.

Persistence: `credentials` + `sessions` tables
(`packages/database/migrations/0002_auth.sql`, drizzle + store functions in
`packages/database/src/schema/auth.ts` — imported via subpath until the
integrator wires the schema barrel). Demo seed users log in with the
password printed by `bun run db:seed` (dev only).

Route handlers must never parse cookies/tokens directly — they read
`c.get("session")`. The web app talks to the API over HTTP only
(`apps/web/lib/session.ts`, login/signup pages).
