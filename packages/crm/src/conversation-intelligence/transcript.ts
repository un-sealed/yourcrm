import type { CallTranscriptRecord, ConversationTurn } from "./types"

/**
 * Transcript normalisation (spec 37 §3, P0).
 *
 * ## Transcripts are INGESTED, not produced — where speech-to-text goes
 *
 * This module turns conversations into structured CRM data. It does not
 * turn AUDIO into text. Speech-to-text needs an audio pipeline (fetch the
 * recording from S3, decode, chunk, stream to an STT endpoint, reassemble
 * with word timings) and a transcription dependency that an agent may not
 * add to `package.json`. Pretending otherwise would mean a half-built
 * pipeline that silently produces nothing.
 *
 * So a transcript arrives as TEXT, by one of two paths, and the seam is
 * `ingestCallTranscript` in `service.ts`:
 *
 *  - **`source: "provider"`** — a notetaker or STT service posts a
 *    transcript payload (Zoom/Meet/Teams notetakers, or a dedicated STT
 *    provider). `providerId` names it and `externalId` is its own id for
 *    the transcript, uniquely indexed per workspace so a webhook
 *    re-delivery is a no-op instead of a duplicate. Speaker labels and
 *    segment timings are taken from the payload: this module never infers
 *    a speaker from audio, so "speaker identification" here means
 *    "faithfully carry through what the provider said", never a guess.
 *  - **`source: "manual"`** — a human pastes the text. The same row, the
 *    same downstream behaviour, no provider.
 *
 * **Wiring a real STT provider therefore changes nothing downstream.** It
 * is an `IntegrationProviderPort` (the pattern in `../integrations`) whose
 * inbound webhook calls `ingestCallTranscript` with `source: "provider"`.
 * The analysis path, the permission model and the storage format all stay
 * exactly as they are. What is missing is the dependency and the audio
 * fetch — both reported as blockers, not smuggled in.
 *
 * ## Why segments are stored as well as text
 *
 * `text` is what the model reads; `segments` is what a human reads in the
 * UI and what talk-time analytics (P1) will aggregate. Deriving one from
 * the other later is lossy in both directions, and the provider gives us
 * both for free.
 */

/** One span of speech, as the provider reported it. */
export type CallTranscriptSegment = {
  speaker: string
  /** Milliseconds from the start of the recording. Null when unreported. */
  startMs: number | null
  endMs: number | null
  text: string
}

/** Segments kept per transcript. A longer payload is truncated, not rejected. */
export const CALL_TRANSCRIPT_MAX_SEGMENTS = 5_000

/** Characters kept per segment. */
export const CALL_TRANSCRIPT_MAX_SEGMENT_CHARS = 5_000

/** Characters kept per transcript body. ~8 hours of speech. */
export const CALL_TRANSCRIPT_MAX_CHARS = 500_000

const UNKNOWN_SPEAKER = "Unknown speaker"

function toText(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function toMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value)
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed)
  }
  return null
}

/**
 * Coerce an arbitrary provider payload into segments. Total: an
 * unrecognised entry is dropped, never a thrown error in a webhook path.
 */
export function normalizeCallTranscriptSegments(value: unknown): CallTranscriptSegment[] {
  if (!Array.isArray(value)) return []
  const out: CallTranscriptSegment[] = []
  for (const entry of value.slice(0, CALL_TRANSCRIPT_MAX_SEGMENTS)) {
    if (typeof entry !== "object" || entry === null) continue
    const record = entry as Record<string, unknown>
    const text = toText(record.text ?? record.content)
    if (text === "") continue
    out.push({
      speaker: toText(record.speaker ?? record.speakerLabel ?? record.name) || UNKNOWN_SPEAKER,
      startMs: toMs(record.startMs ?? record.start_ms ?? record.start),
      endMs: toMs(record.endMs ?? record.end_ms ?? record.end),
      text: text.slice(0, CALL_TRANSCRIPT_MAX_SEGMENT_CHARS),
    })
  }
  return out
}

/** Distinct speakers, in first-appearance order. */
export function callTranscriptSpeakers(segments: readonly CallTranscriptSegment[]): string[] {
  const seen: string[] = []
  for (const segment of segments) {
    if (!seen.includes(segment.speaker)) seen.push(segment.speaker)
  }
  return seen
}

/** `Speaker: text` lines, for when a payload gives segments but no body. */
export function callTranscriptTextFromSegments(segments: readonly CallTranscriptSegment[]): string {
  return segments.map((segment) => `${segment.speaker}: ${segment.text}`).join("\n")
}

/** `HH:MM:SS` for a millisecond offset. Empty when unknown. */
export function formatTranscriptOffset(ms: number | null): string {
  if (ms === null) return ""
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

/**
 * A stored transcript as conversation turns.
 *
 * Prefers `segments` (speaker-attributed, which makes a much better
 * prompt) and falls back to splitting the body on line breaks when the
 * transcript was pasted as a wall of text.
 */
export function callTranscriptToConversationTurns(
  transcript: CallTranscriptRecord,
): ConversationTurn[] {
  const segments = normalizeCallTranscriptSegments(transcript.segments)
  if (segments.length > 0) {
    return segments.map((segment) => ({
      speaker: segment.speaker,
      at: formatTranscriptOffset(segment.startMs) || null,
      text: segment.text,
    }))
  }
  const body = typeof transcript.text === "string" ? transcript.text : ""
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      // "Alice: hello" -> speaker + text; anything else is unattributed.
      const match = /^([^:]{1,60}):\s*(.+)$/.exec(line)
      const speaker = match?.[1]
      const text = match?.[2]
      return speaker !== undefined && text !== undefined
        ? { speaker, at: null, text }
        : { speaker: UNKNOWN_SPEAKER, at: null, text: line }
    })
}
