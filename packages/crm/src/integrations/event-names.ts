/**
 * Integration domain event names.
 *
 * BLOCKER (integrator): `@yourcrm/events` has no integration group. Every
 * other domain's constants live in `packages/events/src/envelope.ts`
 * (`CrmEvents`, `CommunicationEvents`, …) and the house rule is "event
 * constants from `@yourcrm/events`, never string literals; missing constant
 * => blocker". `packages/events` is not this agent's to edit and another
 * agent may be in that file this wave, so the constants are declared here,
 * ONCE, and imported everywhere in this module — no literals anywhere.
 *
 * Resolution: move this object verbatim into `packages/events/src/envelope.ts`
 * as `IntegrationEvents`, add it to the barrel, then reduce this file to
 *
 * ```ts
 * export { IntegrationEvents } from "@yourcrm/events"
 * ```
 *
 * The names below are the ones spec 31 §9 asks for. `sync.started` /
 * `sync.failed` are deliberately absent: P0 has no sync engine, and an
 * unused constant is worse than an honest gap — the sync module adds them
 * when it adds the jobs.
 */
export const IntegrationEvents = {
  Connected: "integration.connected",
  Disconnected: "integration.disconnected",
  Reconnected: "integration.reconnected",
  HealthChecked: "integration.health_checked",
  Errored: "integration.error",
  WebhookReceived: "integration.webhook_received",
} as const

export type IntegrationEventName = (typeof IntegrationEvents)[keyof typeof IntegrationEvents]
