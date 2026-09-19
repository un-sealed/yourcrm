# Wave 1 — Testing Kit Agent (`packages/testing`)

Branch: `agent/testing-kit`

`README.md` in the spec pack lists `packages/testing` in the recommended
repository shape. It was never built.

Eleven module agents are each required to write unit tests, API tests and a
test proving a permission **denial**. With no shared fixtures they will each
invent their own workspace, user, session and permission-context setup —
eleven incompatible versions of the same twenty lines, and denial tests that
each assert something slightly different.

You build the kit they all import.

## You own, exclusively

```text
packages/testing/**    (new package)
```

Nothing else. Do not edit another package to make yours work — if you need a
change elsewhere, report it as a blocker.

Model the package on an existing simple one (`packages/validation`) for its
`package.json`, `tsconfig.json` and source-only layout. Name it
`@yourcrm/testing`. Match the workspace conventions exactly: `main` pointing
at `./src/index.ts`, no build step.

## Build

1. **Identity fixtures** — builders for workspace, user, membership and
   `Session`, with sensible defaults and per-field overrides:
   ```ts
   const session = makeSession({ role: "viewer" })
   ```
   Import the real `Session` type from `@yourcrm/auth` and the real role
   values — never redeclare them, or the fixtures drift from production.
2. **Service context** — `makeServiceContext()` returning the
   `ServiceContext` exported by `@yourcrm/crm` (workspaceId, actorId, role,
   correlationId).
3. **Permission assertions** — the highest-value thing you build:
   ```ts
   await expectDenied(() => service.update(ctx, id, patch))
   await expectAllowed(() => service.list(ctx))
   ```
   `expectDenied` must assert a `PermissionDeniedError` from
   `@yourcrm/permissions` specifically — not merely that *something* threw.
   A test that passes on a typo is worse than no test.
4. **Record factories** — a generic `makeBaseRecord()` covering the
   `BaseRecord` contract (id, workspaceId, timestamps, actors, deletedAt) so
   module agents extend it rather than restating it.
5. **Event capture** — a helper wrapping the in-process `EventBus` from
   `@yourcrm/events`:
   ```ts
   const events = captureEvents()
   ...
   events.expectEmitted("person.created", { entityId: id })
   ```
   Module agents must prove they emit domain events; make that one line.
6. **API test client** — a thin helper for Hono apps: issues a request with
   an `x-request-id`, an optional authenticated session, and asserts the
   shared envelope shape from `@yourcrm/validation` — `{ data, pagination }`
   on success and `{ error: { code, message } }` on failure.
7. **Deterministic time and ids** — `freezeTime()` and a seeded id generator,
   so snapshot-style assertions are stable.

## Rules

- **Hermetic. No live Postgres, Redis or S3** — `docs/conventions.md` requires
  it. Stub transports; if you need a database-shaped seam, make it an
  in-memory fake behind the repository interface.
- `@yourcrm/testing` may import any package. Nothing imports it outside
  `devDependencies` usage in tests — it must never end up in a runtime path.
- No new dependencies. `bun test` and `bun:test` are all you get.
- Every helper needs its own test. A broken fixture silently breaks eleven
  agents' suites, so this package's own coverage matters more than most.
- Write a `README.md` showing the exact copy-pasteable snippet for each
  helper. Module agents will read it instead of your source.

## Deliverable contract

End your report with the exact signature of `makeSession`,
`makeServiceContext`, `expectDenied`, `captureEvents` and the API test client,
so the Wave-2 prompts can reference them verbatim.
