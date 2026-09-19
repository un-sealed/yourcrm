# 06 — API Layer

42 module routers are mounted under `/api/v1` from a generated registry
(`apps/api/src/routes/modules/index.ts`), each exporting `basePath`,
`createRoutes()` and `openApiPaths`. The conventions in `docs/architecture.md`
are followed consistently. Findings are duplication, stale comments and one
process risk.

## 6.1 ✅ Verified — conventions are followed

- **Every member-facing module calls `requireSession()`.** A scripted scan of
  all non-test module files found **zero** member routes without the guard.
  The customer portal deliberately has none (see 6.4).
- **Boundary validation everywhere.** Each route uses `@hono/zod-validator`
  with a `(result, c)` callback that returns the shared
  `errorEnvelope("VALIDATION_ERROR", …)` on failure. List queries, create and
  update bodies all have schemas in the domain package.
- **Error envelopes are uniform.** `{ error: { code, message, requestId, details? } }`
  from `@yourcrm/validation`, with permission denials → 403, unknown ids →
  404, validation → 400, unauthenticated → 401.
- **Pagination is cursor-based** (`{ data, pagination: { nextCursor, limit } }`)
  and exposed through `paginatedEnvelopeSchema`.
- **OpenAPI is real, not a stub.** `apps/api/src/openapi/document.ts`
  assembles `/openapi.json` from each module's `openApiPaths`; every module
  exports operationIds and request schemas. (**Note:** `docs/architecture.md`
  still says "stub at `/openapi.json` today" — that doc is stale, see `09`.)
- **Lazy route wiring is correct.** Route factories build no database
  connection at construction time; the service/repository resolves on first
  request. This is what lets the registry and full-app tests mount every
  module without a live Postgres.
- **The customer portal is a correctly-isolated second auth domain** — its own
  cookie (`yourcrm_portal_session`), its own token table, 404-not-403 for
  out-of-scope records, and it never constructs a member `Session`. See
  `apps/api/src/routes/modules/portal.ts` header.

## 6.2 MEDIUM — `mapError` and the validation callback are copy-pasted ~40×

Every module repeats the same two helpers:

```ts
function mapError(c, err) { /* PermissionDeniedError → 403, NOT_FOUND → 404, else throw */ }
// and an inline zValidator callback building errorEnvelope("VALIDATION_ERROR", …)
```

`people.ts` is the reference; every module mirrors it verbatim
(`apps/api/src/routes/modules/people.ts:83-93` and the four zValidator
callbacks below it). This is ~80 near-identical blocks. When one module fixes
a mapping (e.g. adding a 409 case), the others silently diverge.

**Fix:** extract a shared `mapDomainError(c, err)` and a
`validationHook(schema)` helper (e.g. in `apps/api/src/lib/`), migrate modules
to it, and keep `people.ts` as the documented reference. Low risk, high
consistency payoff. (This is exactly the "no duplicate foundations" rule.)

## 6.3 MEDIUM — route→repository double-casts weaken the type seam

(Cross-ref `04.6`.) The pervasive
`input as unknown as Parameters<typeof repo.create>[2]` pattern
(e.g. `people.ts:56`) means a change to a repository input type will not fail
typecheck at the route seam. Fix by aligning service and repository input
types.

## 6.4 INFO — the portal router is mounted, but its header says it is not

`apps/api/src/routes/modules/portal.ts` header states:

> "this file is not in the generated `routes/modules/index.ts` yet —
> regenerating it is the integrator's step … Until then these routes exist and
> are fully tested but are not mounted on the running app."

That is **false now**: `portalBasePath` is imported and mounted in
`routes/modules/index.ts`. The comment preditcts a state that no longer holds.
Stale comments like this are dangerous — they cause a maintainer to "fix" a
non-problem or to distrust the router. Remove/update it.

## 6.5 MEDIUM — the route registry depends on a manual generator step

`apps/api/src/routes/modules/index.ts` says "do not edit by hand; run
`bun run scripts/gen-routes.ts`". If a module is added or renamed and the
generator is not re-run, the module is simply **absent from the running app**
and its routes 404 — silently. The repo's own `INTEGRATION-TODO` §1 says this
is exactly how "the missing auth routes went unnoticed".

**Fix:** add a CI check (or a test) that imports the registry and asserts
every `routes/modules/*.ts` file with a `basePath` export is present, plus the
same for `packages/crm/src/index.ts` and the schema barrel. A drift test makes
the generator step self-verifying.

## 6.6 LOW — `/api/v1/echo` is an unauthenticated input reflector

`apps/api/src/routes/modules/system.ts` ships `GET /ping` and `POST /echo`
(echoes a validated string) as the registry's worked example. They are
harmless (no data access) but are reachable in production, unauthenticated and
unrated. Consider gating them behind a non-production flag once the patterns
are established elsewhere.

## 6.7 LOW — `PUBLIC` surface has no rate limiting

Only auth login/signup have rate limiters
(`createLoginRateLimiters`). The other public endpoints — `/api/v1/ping`,
`/echo`, the booking-link public routes and portal magic-link requests — rely
on no rate limit. Portal magic-link requests in particular can be used to
trigger emails. Add a lightweight limiter to the portal magic-link request
path at minimum.

## Summary

| # | Severity | Item |
| --- | --- | --- |
| 6.1 | INFO | API conventions verified consistent |
| 6.2 | MEDIUM | `mapError`/validation hook copy-pasted ~40× |
| 6.3 | MEDIUM | Route→repo double-casts (see 4.6) |
| 6.4 | INFO | Portal "not mounted yet" comment is stale/false |
| 6.5 | MEDIUM | Manual route-barrel generator step can silently drop modules |
| 6.6 | LOW | Unauthenticated `/echo` reflector in v1 |
| 6.7 | LOW | Public endpoints (incl. portal magic-link) unrated |
