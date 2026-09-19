# `@yourcrm/search`

Search abstraction. PostgreSQL full-text behind `SearchProvider`; swap to
Meilisearch/Typesense later without touching domain callers.

## Contents

| Export                         | What it is                                            |
| ------------------------------ | ----------------------------------------------------- |
| `SearchProvider`               | The seam. `search()` plus optional `indexDocument()`. |
| `NoopSearchProvider`           | Default; returns no hits. Proves the interface.       |
| `createPostgresSearchProvider` | Real Postgres FTS provider (spec 28-search, P0).      |
| `getSearchProvider` / `set…`   | Process-wide provider registry.                       |

## Layering

This package ships with `zod` only — no database, no domain dependency. The
Postgres provider is a thin adapter:

```text
SearchProvider (here)
  -> PermissionAwareSearchStore port  == createSearchService() in @yourcrm/crm
    -> SearchStore port               == createSearchRepository() in @yourcrm/database
      -> search_index (GIN tsvector)
```

Ranking and SQL live in `@yourcrm/database`; permission filtering lives in
`@yourcrm/crm`. Nothing is duplicated here.

## Permissions

`SearchQuery` carries a workspace but no actor, and spec 28 §8 requires every
result to be filtered by the caller's permissions. `createPostgresSearchProvider`
therefore takes a mandatory `resolveActor(workspaceId)`; returning `null`
raises `SearchActorRequiredError` rather than answering with workspace-wide
data.

```ts
const provider = createPostgresSearchProvider({
  store: searchService, // createSearchService({ store, audit })
  resolveActor: (workspaceId) => currentActorFor(workspaceId),
})
setSearchProvider(provider)
```

## Not wired yet

Neither `apps/api` nor `@yourcrm/crm` declares `@yourcrm/search` as a
dependency, so nothing calls `setSearchProvider` in production today. The HTTP
surface (`/api/v1/search`) talks to the domain service directly. Add the
dependency to `apps/api/package.json` to register this provider at bootstrap.
