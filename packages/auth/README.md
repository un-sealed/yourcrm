# `@yourcrm/auth`

Authentication boundary (foundation stub behind a stable contract).

- `src/session.ts` — `Session`, `requireWorkspace()`, `roleInWorkspace()`,
  `devSession()` for tests.
- The API `auth` middleware resolves real sessions here later
  (Better Auth + OAuth + SAML/OIDC). Route handlers must never parse
  cookies/tokens directly.
