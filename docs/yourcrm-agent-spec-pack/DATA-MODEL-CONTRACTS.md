# Shared Data Model Contracts

## Universal record

```ts
type BaseRecord = {
  id: string
  workspaceId: string
  createdAt: string
  updatedAt: string
  createdBy?: string
  updatedBy?: string
  deletedAt?: string | null
}
```

## Relationship

A relationship contains source object/id, target object/id, relationship type, optional label/metadata and timestamps.

## Audit

Every important mutation records:
- event ID
- workspace
- actor
- action
- object
- record ID
- before/after
- timestamp
- request/correlation ID
- source (`user`, `automation`, `ai`, `integration`, `mcp`)

## Permission

```text
workspace → object → record → field → action
```

Actions:
`read`, `create`, `update`, `delete`, `export`, `share`, `send_external`, `run_automation`, `run_ai`, `admin`.

## Pagination

Use cursor pagination for timelines, inboxes and high-volume collections.

## Soft delete

Business records should normally be soft-deleted and restorable. Permanent deletion requires explicit policy and auditability.
