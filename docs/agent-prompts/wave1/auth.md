# Wave 1 — Authentication Agent

Branch: `agent/auth`

Auth is currently a contract with no implementation: `/api/v1/me` returns 401
and there is no login. Until you finish, **no agent can build or test a
signed-in page**, which is every page in the product.

Specs: `docs/yourcrm-agent-spec-pack/04-authentication.md`,
`docs/yourcrm-agent-spec-pack/05-users-teams-permissions.md`

## You own, exclusively

```text
packages/auth/**
packages/database/migrations/0002_auth.sql   (new)
packages/database/src/schema/auth.ts         (new)
apps/api/src/middleware/auth.ts
apps/web/app/login/page.tsx
apps/web/app/signup/page.tsx
apps/web/lib/session.ts                      (new)
```

Your migration slot is **0002**. Do not use any other number.
Do **not** touch `packages/database/src/schema/index.ts` (the shared-tables
agent owns it this wave), `packages/permissions`, `packages/ui`, or
`apps/api/src/routes/v1.ts` (the platform-seams agent owns it). Export your
schema from your own file; the integrator wires the barrel.

## Scope

- Email + password credentials. **No OAuth, no SAML, no OIDC, no magic links**
  — those are later phases. Do not start them.
- `sessions` table: token hash, user, workspace, expiry, created/last-used,
  user agent. Never store a raw token.
- Password hashing with Bun's built-in `Bun.password` (argon2id). Do not add a
  dependency.
- Signup creates user + workspace + owner membership in one transaction.
- Login issues an httpOnly, secure, sameSite=lax session cookie.
- Logout revokes server-side; expiry is enforced server-side, not by the cookie.
- `resolveSession(request)` in `@yourcrm/auth` returns the existing `Session`
  shape — workspace, user, role — so `requirePermission()` keeps working
  unchanged. **Do not change the `Session` type's shape**; the permissions
  package and every future service depend on it.
- Wire `apps/api/src/middleware/auth.ts` to it so `requireSession()` actually
  authenticates and `/api/v1/me` returns the real user.
- Login and signup pages: use `@yourcrm/ui` primitives if they exist yet, plain
  Tailwind if not (another agent is building them in parallel — do not block on
  it and do not build your own table/dialog primitives).
- Seed users from `packages/database/src/seed.ts` must be able to log in.
  If you change their shape, update the seed.

## Security requirements — these are not optional

- Login failures are generic: never reveal whether the email exists.
- Constant-time comparison for token lookup.
- Rate-limit login attempts per IP and per account.
- Session tokens from a CSPRNG, minimum 32 bytes.
- Regenerate the session token on login to prevent fixation.
- Tests must cover: wrong password rejected, expired session rejected,
  revoked session rejected, and a permission denial for a viewer role.
