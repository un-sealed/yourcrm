# 01 — Architecture & Shared Contracts

## Purpose

Define the technical boundaries that prevent parallel agents from creating incompatible implementations.

## Architecture

Use a modular monorepo with clear separation:

- Web UI
- API/domain services
- background jobs
- database/repositories
- integration adapters
- automation engine
- AI services
- MCP server
- shared UI primitives

## Domain modules

Each domain owns:

- database entities
- domain services
- validation
- permission checks
- API routes
- domain events
- tests

Shared packages must not contain business-specific rules.

## API conventions

Every endpoint must define:

- method
- route
- authentication requirement
- permission
- request schema
- response schema
- pagination
- filtering/sorting
- error codes
- idempotency behavior
- audit event

Use consistent envelopes for errors and pagination.

## Event conventions

Events follow:

```text
<domain>.<entity>.<verb>
```

Examples:

```text
people.person.created
people.person.updated
people.person.deleted
deals.deal.stage_changed
activities.activity.completed
messages.message.received
automation.run.failed
ai.agent.action_requested
```

Events contain:

- event ID
- timestamp
- workspace ID
- actor ID or system actor
- entity type
- entity ID
- previous state where appropriate
- new state where appropriate
- correlation ID
- schema version

## Background jobs

Jobs must be:

- retryable
- idempotent
- observable
- cancellable where possible
- dead-lettered after repeated failure

Use BullMQ initially. Keep an abstraction so Temporal can be introduced later.

## Search

Start with PostgreSQL full-text and indexed columns. Add Meilisearch/Typesense later behind a search interface.

## Files

Never store binary files directly in PostgreSQL. Store metadata in DB and bytes in S3-compatible storage.

## Real-time

Use WebSockets for:

- notifications
- record updates
- inbox messages
- job status
- presence later

Yjs is reserved for collaborative editing where truly needed.

## Acceptance criteria

- Domain module boundaries documented.
- API conventions documented.
- Event envelope implemented.
- Shared error and pagination types exist.
- Job abstraction exists.
- Permission checks can be called consistently.
- Search and file abstractions exist.
