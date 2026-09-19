import type { IntegrationProvider, IntegrationProviderContext } from "@yourcrm/integrations"
import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"
import type { CallStatus } from "./status"

/**
 * Calling service ports (spec 17-calling, P0), following the `people`
 * reference pattern (`../people/types.ts`).
 *
 * `@yourcrm/crm` has no database dependency, so the service talks to these
 * structural store ports; `apps/api/src/routes/modules/calling.ts` adapts
 * `calling-repository.ts` (+ the shared integrations repository, for
 * reading a connected provider's credential) to them. Hermetic tests satisfy
 * them with in-memory fakes.
 */

/* ------------------------------ records -------------------------------- */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type CallRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  status: string
}

export type CallRecordingRecord = Record<string, unknown> & {
  id: string
  callId: string
}

export type CallListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  direction?: "inbound" | "outbound"
  status?: string
  personId?: string
  companyId?: string
  dealId?: string
  ownerId?: string
  /** Free-text match against from/to numbers, disposition and notes. */
  query?: string
}

export type CallListResult = {
  data: CallRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

/* -------------------------------- stores -------------------------------- */

export type CallingStore = {
  list(workspaceId: string, query: CallListQuery): Promise<CallListResult>
  findById(workspaceId: string, id: string): Promise<CallRecord | null>
  /** How an inbound status webhook finds the call it belongs to. */
  findByProviderCallId(
    workspaceId: string,
    providerId: string,
    providerCallId: string,
  ): Promise<CallRecord | null>
  create(workspaceId: string, input: Record<string, unknown>, actorId?: string): Promise<CallRecord>
  /** Free-form patch (notes, disposition, owner, links). Never changes status. */
  update(
    workspaceId: string,
    id: string,
    patch: Record<string, unknown>,
    actorId?: string,
  ): Promise<CallRecord | null>
  /**
   * Guarded status transition (see `./status.ts`). `applied` is false when
   * the incoming status was out-of-order/late/post-terminal and the store
   * left the row untouched — callers must not emit events/audit for a
   * no-op.
   */
  advanceStatus(
    workspaceId: string,
    id: string,
    next: {
      status: CallStatus
      occurredAt: Date
      startedAt?: Date | null
      endedAt?: Date | null
      durationSeconds?: number | null
      errorMessage?: string | null
    },
  ): Promise<{ record: CallRecord | null; applied: boolean }>
  softDelete(workspaceId: string, id: string, actorId?: string): Promise<void>
  restore(workspaceId: string, id: string): Promise<void>
}

export type CallRecordingStore = {
  create(
    workspaceId: string,
    input: {
      callId: string
      url: string
      durationSeconds?: number | null
      sizeBytes?: number | null
    },
    actorId?: string,
  ): Promise<CallRecordingRecord>
  listForCall(workspaceId: string, callId: string): Promise<CallRecordingRecord[]>
}

/* ---------------------- integration connection lookup ------------------- */

/**
 * Minimal read slice of the shared integrations framework's connection
 * store (`@yourcrm/crm/src/integrations` `IntegrationConnectionStore`,
 * backed by `packages/database/src/repositories/integrations-repository.ts`)
 * — click-to-call reads a connection and its credential, it never writes
 * one (connecting/rotating a provider stays the integrations module's job).
 */
export type CallingConnectionRecord = {
  id: string
  workspaceId: string
  providerId: string
  status: string
  config: Record<string, unknown>
}

export type CallingConnectionLookupPort = {
  findById(workspaceId: string, id: string): Promise<CallingConnectionRecord | null>
  /** Every connected connection in the workspace — used to auto-select a calling provider. */
  listConnected(workspaceId: string): Promise<CallingConnectionRecord[]>
}

export type CallingCredentialReadPort = {
  /** The connection's decrypted `api_key`. Never logged, persisted or returned. */
  readSecret(workspaceId: string, connectionId: string): Promise<string | null>
}

/* -------------------------------- provider ------------------------------- */

/** What a provider hands back immediately after being asked to place a call. */
export type PlaceCallProviderResult = {
  /** Provider-side call sid; how its status webhook finds the row back. */
  providerCallId: string
  /** Optional immediate status (defaults to "queued" when omitted). */
  status?: CallStatus
}

/**
 * Calling providers implement the shared `IntegrationProvider` contract
 * (`@yourcrm/integrations`) — connect/disconnect/healthCheck/webhook — PLUS
 * one calling-specific action the base contract does not standardise:
 * `placeCall`. The base contract intentionally has no generic "send" hook
 * (email/messaging/calling each need a differently-shaped one), so each
 * consuming module extends it the same way this type does.
 */
export type CallingProviderPort = IntegrationProvider & {
  placeCall(
    ctx: IntegrationProviderContext,
    input: { fromNumber: string; toNumber: string },
  ): Promise<PlaceCallProviderResult>
}

export type CallingProviderCatalogPort = {
  get(providerId: string): CallingProviderPort | null
  list(): CallingProviderPort[]
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type CallAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: "user" | "automation" | "ai" | "integration" | "mcp"
}

export type CallingServiceContext = ServiceContext

export type CallingServiceDeps = {
  store: CallingStore
  recordings: CallRecordingStore
  connections: CallingConnectionLookupPort
  credentials: CallingCredentialReadPort
  providers: CallingProviderCatalogPort
  audit: AuditWriter<CallAuditInput>
  events?: EventEmitter
  /** Injectable clock — hermetic tests assert exact timestamps. */
  now?: () => Date
}
