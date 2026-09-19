# `@yourcrm/events`

Canonical domain-event envelope + in-process bus.

- `src/envelope.ts` — `DomainEvent`, `createEvent()`, per-domain event
  name constants from `EVENTS-AND-INTEGRATIONS.md`.
- `src/bus.ts` — `EventBus` interface used by domain services and tests.
  Redis pub/sub fan-out is a worker concern; domain code emits here.
