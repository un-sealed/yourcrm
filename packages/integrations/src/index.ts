/**
 * `@yourcrm/integrations` — third-party adapter boundary (email, calendar,
 * WhatsApp, telephony, …). INTENTIONAL PLACEHOLDER.
 *
 * Rules for later agents: one adapter module per provider, each exposing a
 * uniform interface and emitting `CommunicationEvents`. Secrets stay in env;
 * never persist tokens outside encrypted columns.
 */

export const INTEGRATIONS_BOUNDARY_VERSION = 0 as const

export type AdapterStatus = "connected" | "disconnected" | "error"

export interface IntegrationAdapter {
  readonly provider: string
  status(): Promise<AdapterStatus>
}
