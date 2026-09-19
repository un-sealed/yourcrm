import { CommunicationEvents, createEvent, getEventBus } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import { redactIntegrationSecrets } from "../integrations"
import { normalizeE164 } from "./phone"
import { callQuerySchema, logCallSchema, placeCallSchema, updateCallSchema } from "./schemas"
import { decideCallStatusTransition, isTerminalCallStatus, type CallStatus } from "./status"
import type {
  CallListResult,
  CallRecord,
  CallRecordingRecord,
  CallingServiceContext,
  CallingServiceDeps,
} from "./types"

/**
 * Calling domain service (spec 17-calling, P0), mirroring the `people`
 * reference pattern: every method calls `requirePermission()` first, does
 * the work through the injected store ports, emits the domain event (when
 * one exists — see the note on `CommunicationEvents` below) and writes an
 * audit row for every mutation.
 */

export class CallNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`call ${id} not found`)
    this.name = "CallNotFoundError"
  }
}

/** No connection was specified and none (or more than one) is unambiguously usable. */
export class NoCallingProviderConnectedError extends Error {
  readonly code = "NO_PROVIDER_CONNECTED"
  constructor() {
    super(
      "no calling provider is connected for this workspace — connect one in Settings > Integrations, or log this call manually",
    )
    this.name = "NoCallingProviderConnectedError"
  }
}

export class AmbiguousCallingConnectionError extends Error {
  readonly code = "AMBIGUOUS_CONNECTION"
  constructor() {
    super("more than one calling provider is connected — specify connectionId")
    this.name = "AmbiguousCallingConnectionError"
  }
}

export class CallingConnectionNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`integration connection ${id} not found`)
    this.name = "CallingConnectionNotFoundError"
  }
}

export class CallingConnectionNotConnectedError extends Error {
  readonly code = "CONNECTION_NOT_CONNECTED"
  constructor(id: string) {
    super(`connection ${id} is not connected`)
    this.name = "CallingConnectionNotConnectedError"
  }
}

export class CallingProviderNotRegisteredError extends Error {
  readonly code = "NOT_FOUND"
  constructor(providerId: string) {
    super(`calling provider "${providerId}" is not registered`)
    this.name = "CallingProviderNotRegisteredError"
  }
}

export class MissingCallerIdError extends Error {
  readonly code = "VALIDATION_ERROR"
  constructor() {
    super("fromNumber was not supplied and the connection has no configured caller id")
    this.name = "MissingCallerIdError"
  }
}

/** The provider rejected or failed the call placement. The attempt is still recorded. */
export class CallingProviderCallFailedError extends Error {
  readonly code = "CALLING_PROVIDER_CALL_FAILED"
  constructor(
    providerId: string,
    reason: string,
    readonly callId: string,
  ) {
    super(`provider "${providerId}" failed to place the call: ${reason}`)
    this.name = "CallingProviderCallFailedError"
  }
}

export class RecordingConsentRequiredError extends Error {
  readonly code = "RECORDING_CONSENT_REQUIRED"
  constructor(id: string) {
    super(`call ${id} has no recording consent on file — cannot attach a recording`)
    this.name = "RecordingConsentRequiredError"
  }
}

function permissionOf(
  ctx: CallingServiceContext,
  action: "read" | "create" | "update" | "delete" | "send_external",
) {
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: "call",
    action,
  }
}

function computeDuration(startedAt?: Date | null, endedAt?: Date | null): number | null {
  if (!startedAt || !endedAt) return null
  const seconds = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)
  return seconds >= 0 ? seconds : null
}

export type ApplyProviderStatusEventInput = {
  workspaceId: string
  providerId: string
  providerCallId: string
  status: CallStatus
  occurredAt: Date
  durationSeconds?: number | null
  errorMessage?: string | null
}

export type ApplyProviderStatusEventResult = {
  applied: boolean
  reason: string
  call: CallRecord | null
}

export function createCallingService(deps: CallingServiceDeps) {
  const events = deps.events ?? getEventBus()
  const now = deps.now ?? (() => new Date())

  async function list(ctx: CallingServiceContext, rawQuery: unknown): Promise<CallListResult> {
    requirePermission(permissionOf(ctx, "read"))
    const query = callQuerySchema.parse(rawQuery)
    return deps.store.list(ctx.workspaceId, query)
  }

  async function get(
    ctx: CallingServiceContext,
    id: string,
  ): Promise<{ call: CallRecord; recordings: CallRecordingRecord[] }> {
    requirePermission(permissionOf(ctx, "read"))
    const call = await deps.store.findById(ctx.workspaceId, id)
    if (!call) throw new CallNotFoundError(id)
    // Recordings are gated by the SAME read check as the call itself: an
    // actor without read on the call never reaches this line, so recording
    // urls never leak through a separate, weaker path.
    const recordings = await deps.recordings.listForCall(ctx.workspaceId, id)
    return { call, recordings }
  }

  /** Manual log: a rep records a call made outside the system. No provider required. */
  async function logCall(ctx: CallingServiceContext, rawInput: unknown): Promise<CallRecord> {
    requirePermission(permissionOf(ctx, "create"))
    const input = logCallSchema.parse(rawInput)
    const fromNumber = normalizeE164(input.fromNumber)
    const toNumber = normalizeE164(input.toNumber)
    const startedAt = input.startedAt ?? null
    const endedAt = input.endedAt ?? null
    const durationSeconds = input.durationSeconds ?? computeDuration(startedAt, endedAt)

    const call = await deps.store.create(
      ctx.workspaceId,
      {
        direction: input.direction,
        status: input.status,
        source: "manual",
        fromNumber,
        toNumber,
        personId: input.personId ?? null,
        companyId: input.companyId ?? null,
        dealId: input.dealId ?? null,
        ownerId: input.ownerId ?? ctx.actorId,
        startedAt,
        endedAt,
        durationSeconds,
        disposition: input.disposition ?? null,
        notes: input.notes ?? null,
        recordingConsent: input.recordingConsent,
      },
      ctx.actorId,
    )
    await emitIfCompleted({
      workspaceId: ctx.workspaceId,
      call,
      actorId: ctx.actorId,
      correlationId: ctx.correlationId,
    })
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "log",
      object: "call",
      recordId: call.id,
      after: call,
      correlationId: ctx.correlationId,
    })
    return call
  }

  /** Click-to-call: ask a connected provider to place the call, and record the attempt either way. */
  async function placeCall(ctx: CallingServiceContext, rawInput: unknown): Promise<CallRecord> {
    requirePermission(permissionOf(ctx, "send_external"))
    const input = placeCallSchema.parse(rawInput)

    const connection = input.connectionId
      ? await deps.connections.findById(ctx.workspaceId, input.connectionId)
      : await autoSelectConnection(ctx.workspaceId)
    if (!connection) {
      if (input.connectionId) throw new CallingConnectionNotFoundError(input.connectionId)
      throw new NoCallingProviderConnectedError()
    }
    if (connection.status !== "connected") {
      throw new CallingConnectionNotConnectedError(connection.id)
    }
    const provider = deps.providers.get(connection.providerId)
    if (!provider) throw new CallingProviderNotRegisteredError(connection.providerId)

    const toNumber = normalizeE164(input.toNumber)
    const configuredCallerId =
      typeof connection.config.callerId === "string" ? connection.config.callerId : undefined
    const rawFrom = input.fromNumber ?? configuredCallerId
    if (!rawFrom) throw new MissingCallerIdError()
    const fromNumber = normalizeE164(rawFrom)

    // The attempt is recorded before the provider call, so a rejected/failed
    // placement still leaves a visible row a rep can see and retry from.
    const attempt = await deps.store.create(
      ctx.workspaceId,
      {
        direction: "outbound",
        status: "queued",
        source: "provider",
        fromNumber,
        toNumber,
        personId: input.personId ?? null,
        companyId: input.companyId ?? null,
        dealId: input.dealId ?? null,
        ownerId: ctx.actorId,
        connectionId: connection.id,
        providerId: connection.providerId,
        recordingConsent: input.recordingConsent,
      },
      ctx.actorId,
    )

    const secret = await deps.credentials.readSecret(ctx.workspaceId, connection.id)
    try {
      const result = await provider.placeCall(
        {
          workspaceId: ctx.workspaceId,
          connectionId: connection.id,
          config: connection.config,
          secret,
        },
        { fromNumber, toNumber },
      )
      const placed = await deps.store.update(
        ctx.workspaceId,
        attempt.id,
        { providerCallId: result.providerCallId },
        ctx.actorId,
      )
      const withStatus = result.status
        ? (
            await deps.store.advanceStatus(ctx.workspaceId, attempt.id, {
              status: result.status,
              occurredAt: now(),
            })
          ).record
        : placed
      const finalRecord = withStatus ?? placed ?? attempt
      await emitIfCompleted({
        workspaceId: ctx.workspaceId,
        call: finalRecord,
        before: attempt,
        actorId: ctx.actorId,
        correlationId: ctx.correlationId,
      })
      await deps.audit({
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        action: "place",
        object: "call",
        recordId: attempt.id,
        after: finalRecord,
        correlationId: ctx.correlationId,
      })
      return finalRecord
    } catch (err) {
      const reason = redactIntegrationSecrets(
        err instanceof Error ? err.message : String(err),
        secret,
      )
      const { record: failed } = await deps.store.advanceStatus(ctx.workspaceId, attempt.id, {
        status: "failed",
        occurredAt: now(),
        endedAt: now(),
        errorMessage: reason,
      })
      await deps.audit({
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        action: "place_failed",
        object: "call",
        recordId: attempt.id,
        after: failed ?? { status: "failed", error: reason },
        correlationId: ctx.correlationId,
      })
      throw new CallingProviderCallFailedError(connection.providerId, reason, attempt.id)
    }
  }

  async function autoSelectConnection(workspaceId: string) {
    const connected = await deps.connections.listConnected(workspaceId)
    const usable = connected.filter((c) => deps.providers.get(c.providerId) !== null)
    if (usable.length === 0) return null
    if (usable.length > 1) throw new AmbiguousCallingConnectionError()
    return usable[0] ?? null
  }

  async function update(
    ctx: CallingServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<CallRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const patch = updateCallSchema.parse(rawPatch)
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new CallNotFoundError(id)
    const after = await deps.store.update(
      ctx.workspaceId,
      id,
      patch as Record<string, unknown>,
      ctx.actorId,
    )
    if (!after) throw new CallNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: "call",
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  async function addRecording(
    ctx: CallingServiceContext,
    callId: string,
    input: { url: string; durationSeconds?: number | null; sizeBytes?: number | null },
  ): Promise<CallRecordingRecord> {
    requirePermission(permissionOf(ctx, "update"))
    const call = await deps.store.findById(ctx.workspaceId, callId)
    if (!call) throw new CallNotFoundError(callId)
    if (call.recordingConsent !== true) throw new RecordingConsentRequiredError(callId)
    const recording = await deps.recordings.create(
      ctx.workspaceId,
      {
        callId,
        url: input.url,
        durationSeconds: input.durationSeconds,
        sizeBytes: input.sizeBytes,
      },
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "recording_attached",
      object: "call",
      recordId: callId,
      after: { recordingId: recording.id },
      correlationId: ctx.correlationId,
    })
    return recording
  }

  async function softDelete(ctx: CallingServiceContext, id: string): Promise<CallRecord> {
    requirePermission(permissionOf(ctx, "delete"))
    const before = await deps.store.findById(ctx.workspaceId, id)
    if (!before) throw new CallNotFoundError(id)
    await deps.store.softDelete(ctx.workspaceId, id, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: "call",
      recordId: id,
      before,
      correlationId: ctx.correlationId,
    })
    return before
  }

  async function restore(ctx: CallingServiceContext, id: string): Promise<CallRecord> {
    requirePermission(permissionOf(ctx, "update"))
    await deps.store.restore(ctx.workspaceId, id)
    const after = await deps.store.findById(ctx.workspaceId, id)
    if (!after) throw new CallNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "restore",
      object: "call",
      recordId: id,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /**
   * Applies an inbound provider status event (a verified, de-duplicated
   * webhook delivery — see `provider.ts`'s `onStatusEvent`). No
   * `ServiceContext`: the caller is the provider, not a user, mirroring
   * `IntegrationsService.ingestWebhook`. Never throws for an
   * unmatched/out-of-order event — those are expected, reported as
   * `applied: false`, and must be treated as no-ops by the caller.
   */
  async function applyProviderStatusEvent(
    input: ApplyProviderStatusEventInput,
  ): Promise<ApplyProviderStatusEventResult> {
    const call = await deps.store.findByProviderCallId(
      input.workspaceId,
      input.providerId,
      input.providerCallId,
    )
    if (!call) {
      return { applied: false, reason: "no call found for this provider call id", call: null }
    }
    const decision = decideCallStatusTransition(call.status as CallStatus, input.status)
    if (!decision.applied) {
      return { applied: false, reason: decision.reason, call }
    }
    const wasNonTerminal = !isTerminalCallStatus(call.status as CallStatus)
    const { record, applied } = await deps.store.advanceStatus(input.workspaceId, call.id, {
      status: input.status,
      occurredAt: input.occurredAt,
      startedAt: input.status === "in_progress" && !call.startedAt ? input.occurredAt : undefined,
      endedAt: isTerminalCallStatus(input.status) ? input.occurredAt : undefined,
      durationSeconds: input.durationSeconds ?? undefined,
      errorMessage: input.errorMessage ?? undefined,
    })
    if (!applied || !record) {
      return { applied: false, reason: "blocked by the store's own guard (race)", call }
    }
    if (wasNonTerminal) {
      await emitIfCompleted({
        workspaceId: input.workspaceId,
        actorType: "integration",
        call: record,
        before: call,
      })
      await deps.audit({
        workspaceId: input.workspaceId,
        actorId: null,
        action: "status_advanced",
        object: "call",
        recordId: call.id,
        before: { status: call.status },
        after: { status: record.status },
        source: "integration",
      })
    }
    return { applied: true, reason: decision.reason, call: record }
  }

  /**
   * `CommunicationEvents` (`@yourcrm/events`) only exports `CallCompleted`
   * today — there is no `call.started`/`call.answered`/`call.recording_ready`
   * constant yet (spec 17-calling §9 lists all four; only one exists in the
   * shared package `@yourcrm/crm` does not own). Per this agent's hard
   * rules, a missing event constant is a blocker to report, not a string
   * literal to invent — so only the transition INTO `completed` emits an
   * event; every other mutation still writes an audit row.
   */
  async function emitIfCompleted(input: {
    workspaceId: string
    call: CallRecord
    before?: CallRecord | null
    actorId?: string
    actorType?: "user" | "automation" | "ai" | "integration" | "mcp" | "system"
    correlationId?: string
  }): Promise<void> {
    if (input.call.status !== "completed") return
    await events.emit(
      createEvent({
        event: CommunicationEvents.CallCompleted,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        actorType: input.actorType ?? "user",
        entityType: "call",
        entityId: input.call.id,
        before: input.before ?? undefined,
        after: input.call,
        correlationId: input.correlationId,
      }),
    )
  }

  return {
    list,
    get,
    logCall,
    placeCall,
    update,
    addRecording,
    softDelete,
    restore,
    applyProviderStatusEvent,
  }
}

export type CallingService = ReturnType<typeof createCallingService>
