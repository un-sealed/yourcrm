# `@yourcrm/testing`

Shared testing kit for module agents. Every helper is hermetic — no live
Postgres, Redis or S3 — and every helper has its own test in `src/*.test.ts`.

Import from `@yourcrm/testing` in `devDependencies` test files only. It must
never appear in a runtime path.

```ts
import {
  captureEvents,
  createApiClient,
  createIdGenerator,
  createStore,
  expectAllowed,
  expectDenied,
  freezeTime,
  makeBaseRecord,
  makeServiceContext,
  makeSession,
} from "@yourcrm/testing"
```

## Identity fixtures

Builders for workspace, user, membership and `Session`. They use the real
`Session` type and real role values from `@yourcrm/auth` — roles are never
redeclared here. Every field has a sensible default; override per field.

```ts
const session = makeSession({ role: "viewer" })
const owner = makeSession({ workspaceId: "ws_acme", userId: "u_ada", role: "owner" })
makeWorkspace({ name: "Acme" }) // { id: "ws_0001", name: "Acme" }
makeUser({ email: "ada@example.com" }) // { id: "user_0001", email: ... }
makeMembership({ workspaceId: "ws_acme", role: "admin" })
```

Default role is `"owner"` so happy-path tests pass; denial tests override
with `"viewer"`. Call `resetIdCounter()` (from time helpers) in `beforeEach`
when asserting exact ids.

## Service context

`makeServiceContext()` returns the real `ServiceContext` from `@yourcrm/crm`.
Pass a session to derive the caller, or set fields directly — explicit
fields always win.

```ts
const ctx = makeServiceContext({ session: makeSession({ role: "viewer" }) })
const admin = makeServiceContext({ workspaceId: "ws_1", actorId: "u_1", role: "admin" })
```

## Permission assertions

```ts
await expectDenied(() => service.update(ctx, id, patch))
await expectAllowed(() => service.list(ctx))
```

`expectDenied` passes **only** on the real `PermissionDeniedError` from
`@yourcrm/permissions` — any other throw (including a typo-induced
`TypeError`), or no throw at all, fails the test. It returns the error for
further assertions. `expectAllowed` returns the resolved value, fails
clearly on denial, and rethrows any other error untouched.

## Record factories

`makeBaseRecord()` covers the `BaseRecord` contract (`id`, `workspaceId`,
timestamps, actors, `deletedAt: null`). Extend it instead of restating it:

```ts
const person = { ...makeBaseRecord({ workspaceId: ctx.workspaceId }), firstName: "Ada" }
```

Timestamps follow the `freezeTime()` clock when frozen.

## Event capture

```ts
const events = captureEvents()
try {
  await service.create(ctx, input)
  events.expectEmitted("person.created", { entityId: id })
} finally {
  events.release()
}
```

`expectEmitted(name, match?)` matches `workspaceId`, `actorId`,
`entityType`, `entityId`, `correlationId` plus deep-compared
`before`/`after` payloads, and throws a descriptive error naming the
missing event. Also: `events.count(name?)`, `events.clear()`,
`events.release()`. Pass an explicit `EventBus` to isolate from the shared
singleton: `captureEvents(new EventBus())`.

## API test client

```ts
const api = createApiClient({ app, session: makeSession({ role: "viewer" }) })
const res = await api.get("/api/v1/people")
const { data, pagination } = res.expectSuccess()
;(await api.get("/api/v1/me")).expectError("UNAUTHORIZED")
```

Every request sends `x-request-id` (generated per request unless given).
`expectSuccess()` asserts `{ data, pagination? }` (`pagination`, when
present, must be `{ nextCursor, limit }`); `expectError(code?)` asserts
`{ error: { code, message } }` via the shared schema from
`@yourcrm/validation`. Methods: `get/post/put/patch/delete/request`, each
accepting `{ session, requestId, headers, expectedStatus }` overrides.

The client sends the exact session fixture as `x-test-session`
(base64url JSON; see `encodeTestSession`/`decodeTestSession`) plus
`x-dev-session: 1` for the current foundation auth hook. Test apps that
need role-accurate sessions should honor `x-test-session`:

```ts
import { decodeTestSession } from "@yourcrm/testing"
// in test middleware: const session = decodeTestSession(c.req.header("x-test-session"))
```

## Deterministic time and ids

```ts
let clock: FrozenTime
beforeEach(() => {
  resetIdCounter()
  clock = freezeTime("2026-01-01T00:00:00.000Z")
})
afterEach(() => {
  clock.restore()
})

const newId = createIdGenerator({ prefix: "person", start: 1 })
newId() // "person_0001"
nextId("ws") // process-wide deterministic id ("ws_0001", …)
```

`freezeTime()` pins `Date.now()` and the no-arg `new Date()` constructor;
explicit date arguments pass through. Always `restore()` it.

## In-memory store

Workspace-scoped, soft-delete-aware fake behind a repository-style
interface — the database-shaped seam for hermetic service tests:

```ts
const people = createStore<Person>()
people.insert({ ...makeBaseRecord({ workspaceId }), firstName: "Ada" })
people.get(id, workspaceId) // null when missing, cross-workspace, or deleted
people.list(workspaceId) // live rows only, insertion order
people.update(id, workspaceId, patch) // guards id/workspace/creation fields, bumps updatedAt
people.remove(id, workspaceId) // soft delete; people.restore(...) revives
people.clear() // typically in beforeEach
```
