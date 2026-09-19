import {
  AiEvents,
  AutomationEvents,
  CalendarEvents,
  CommunicationEvents,
  ConversationEvents,
  CrmEvents,
  CustomObjectEvents,
  DashboardEvents,
  FileEvents,
  FormEvents,
  IntegrationEvents,
  InvoiceEvents,
  PipelineEvents,
  ProductEvents,
  QuoteEvents,
  ReportEvents,
  SearchEvents,
  TransferEvents,
} from "@yourcrm/events"

/**
 * Event names this module PRODUCES, and the catalogue of names a
 * subscription may subscribe TO.
 *
 * ## Produced names — BLOCKER (integrator)
 *
 * `@yourcrm/events` has no webhook or api-key group. Spec 32 §9 asks for
 * `webhook.delivery_succeeded`, `webhook.delivery_failed` and
 * `api_key.created`, and the house rule is "event constants from
 * `@yourcrm/events`, never string literals; a missing one is a blocker".
 * `packages/events` is not this agent's to edit and sibling agents may be
 * in that file this wave, so the three constants are declared here ONCE and
 * imported everywhere in this module — no literal appears anywhere else.
 *
 * Resolution: move `WebhookEvents` verbatim into
 * `packages/events/src/envelope.ts`, add it to that package's barrel, then
 * reduce this half of the file to
 *
 * ```ts
 * export { WebhookEvents } from "@yourcrm/events"
 * ```
 *
 * Nothing else in this module changes. (`packages/crm/src/integrations/
 * event-names.ts` carries the identical note for `IntegrationEvents`, which
 * has since landed upstream — this is the same migration, one wave later.)
 *
 * ## Subscribable names — derived, never hand-listed
 *
 * `SUBSCRIBABLE_EVENT_NAMES` is computed from the exported `@yourcrm/events`
 * constant groups. A hand-maintained copy would drift the first time a
 * module adds an event: with this, a new constant is subscribable the moment
 * it lands, and a subscription can never name an event that does not exist.
 */

export const WebhookEvents = {
  DeliverySucceeded: "webhook.delivery_succeeded",
  DeliveryFailed: "webhook.delivery_failed",
  ApiKeyCreated: "api_key.created",
} as const

export type WebhookEventName = (typeof WebhookEvents)[keyof typeof WebhookEvents]

/**
 * Every domain event group `@yourcrm/events` exports.
 *
 * `WebhookEvents` is deliberately NOT in this list. A subscription that
 * could subscribe to `webhook.delivery_failed` would enqueue a delivery for
 * every failed delivery — including its own — and that feedback loop is
 * unbounded. The dispatcher refuses those names a second time at run time
 * (`isSubscribableEventName`), so neither a stale row nor a hand-written
 * SQL insert can start one.
 */
const EVENT_GROUPS = [
  AiEvents,
  AutomationEvents,
  CalendarEvents,
  CommunicationEvents,
  ConversationEvents,
  CrmEvents,
  CustomObjectEvents,
  DashboardEvents,
  FileEvents,
  FormEvents,
  IntegrationEvents,
  InvoiceEvents,
  PipelineEvents,
  ProductEvents,
  QuoteEvents,
  ReportEvents,
  SearchEvents,
  TransferEvents,
] as const satisfies readonly Readonly<Record<string, string>>[]

const PRODUCED_NAMES = new Set<string>(Object.values(WebhookEvents))

/** Sorted, de-duplicated catalogue of subscribable event names. */
export const SUBSCRIBABLE_EVENT_NAMES: readonly string[] = [
  ...new Set(EVENT_GROUPS.flatMap((group) => Object.values(group))),
]
  .filter((name) => !PRODUCED_NAMES.has(name))
  .sort()

const SUBSCRIBABLE = new Set(SUBSCRIBABLE_EVENT_NAMES)

export function isSubscribableEventName(value: unknown): value is string {
  return typeof value === "string" && SUBSCRIBABLE.has(value)
}

/**
 * Catalogue entry for the UI's event picker: the name plus its domain
 * prefix, so the page can group without re-deriving the taxonomy.
 */
export type SubscribableEventDescriptor = {
  name: string
  domain: string
}

export function listSubscribableEvents(): SubscribableEventDescriptor[] {
  return SUBSCRIBABLE_EVENT_NAMES.map((name) => ({
    name,
    domain: name.split(".")[0] ?? name,
  }))
}
