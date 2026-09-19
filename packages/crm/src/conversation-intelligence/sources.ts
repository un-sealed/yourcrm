import { callTranscriptToConversationTurns } from "./transcript"
import type {
  ConversationIntelligenceStore,
  ConversationSource,
  ConversationSourcePort,
  ConversationSourceRegistry,
  ConversationSubjectType,
} from "./types"
import type { ServiceContext } from "../index"

/**
 * Conversation sources: how this module reaches a conversation it does
 * not own (spec 37, P0).
 *
 * ## Why these are ports and not imports
 *
 * Email, WhatsApp and Calling each own their conversations, their
 * permission objects and their record-level visibility rules. This module
 * reads them through an adapter over the OWNING module's domain service,
 * assembled in the composition root
 * (`apps/api/src/routes/modules/conversation-intelligence.ts`) — the same
 * shape `AiActionApplierPort` uses to reach a module it must not import.
 *
 * Three consequences, all deliberate:
 *
 *  1. **Permission inheritance is structural.** The owning service runs
 *     its own `requirePermission()` and its own visibility rules on every
 *     load. This module cannot see a conversation the caller could not
 *     open by hand, because it has no other way to see one at all.
 *  2. **A deployment without a module simply has no source for it.** The
 *     registry reports which subject types exist; the rest are not
 *     analysable and are excluded from every list query. Nothing degrades
 *     into "readable by default".
 *  3. **Missing and hidden are the same answer.** `load` returns `null`
 *     for both, so an analysis request cannot be used to probe whether a
 *     thread exists.
 */

/** What an adapter knows about a subject, minus its identity. */
export type ConversationSubjectReading = Omit<ConversationSource, "subjectType" | "subjectId">

/**
 * The owning module's read path, narrowed to what this module needs.
 *
 * `read` MUST return `null` both when the subject is missing and when the
 * caller may not see it — including when the owning service throws
 * `PermissionDeniedError` or its own not-found error.
 */
export type ConversationSubjectReader = {
  read(ctx: ServiceContext, subjectId: string): Promise<ConversationSubjectReading | null>
  /**
   * Which of these ids the caller may read. A page of analyses calls this
   * once per subject type, so a list costs a bounded number of round
   * trips rather than one per row.
   */
  filterReadable(ctx: ServiceContext, subjectIds: readonly string[]): Promise<string[]>
}

/** Bind a reader to a subject type. */
export function createConversationSource(
  subjectType: ConversationSubjectType,
  reader: ConversationSubjectReader,
): ConversationSourcePort {
  return {
    subjectType,
    load: async (ctx, subjectId) => {
      const reading = await reader.read(ctx, subjectId)
      return reading === null ? null : { ...reading, subjectType, subjectId }
    },
    filterReadable: async (ctx, subjectIds) =>
      subjectIds.length === 0 ? [] : reader.filterReadable(ctx, subjectIds),
  }
}

/**
 * Registry of the sources a deployment has. Last registration for a
 * subject type wins, so a composition root can override the default call
 * source without removing it first.
 */
export function createConversationSourceRegistry(
  sources: readonly ConversationSourcePort[],
): ConversationSourceRegistry {
  const bySubjectType = new Map<ConversationSubjectType, ConversationSourcePort>()
  for (const source of sources) bySubjectType.set(source.subjectType, source)
  return {
    get: (subjectType) => bySubjectType.get(subjectType) ?? null,
    subjectTypes: () => [...bySubjectType.keys()],
  }
}

export type CallTranscriptConversationSourceDeps = {
  /**
   * The Calling module's read path for the CALL itself. This is what
   * enforces who may read the conversation; the transcript below is only
   * its text. A transcript is never readable through a weaker gate than
   * the call it belongs to.
   */
  calls: ConversationSubjectReader
  /** This module's own transcript store. */
  store: Pick<ConversationIntelligenceStore, "listTranscripts">
  /** Transcripts merged per call. Default 1 — the most recent. */
  transcriptLimit?: number
}

/**
 * The `call` source: permission and metadata from the Calling module, text
 * from this module's own `call_transcripts`.
 *
 * A call with no transcript yet is readable but not analysable — `load`
 * returns a source with no turns, and the service refuses to spend tokens
 * on an empty conversation. That is the honest answer while the
 * speech-to-text seam (see `transcript.ts`) is unwired.
 */
export function createCallTranscriptConversationSource(
  deps: CallTranscriptConversationSourceDeps,
): ConversationSourcePort {
  const limit = deps.transcriptLimit ?? 1
  return createConversationSource("call", {
    read: async (ctx, subjectId) => {
      const call = await deps.calls.read(ctx, subjectId)
      if (call === null) return null
      const transcripts = await deps.store.listTranscripts(
        ctx.workspaceId,
        "call",
        subjectId,
        limit,
      )
      const turns = transcripts.flatMap(callTranscriptToConversationTurns)
      const speakers = [...new Set(turns.map((turn) => turn.speaker))]
      return {
        ...call,
        turns: turns.length > 0 ? turns : call.turns,
        participants: call.participants.length > 0 ? call.participants : speakers,
      }
    },
    filterReadable: (ctx, subjectIds) => deps.calls.filterReadable(ctx, subjectIds),
  })
}
