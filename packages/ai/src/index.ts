/**
 * `@yourcrm/ai` — AI service boundary (Vercel AI SDK lives here in Phase 3).
 *
 * INTENTIONAL PLACEHOLDER. Rules for later agents:
 * - AI consumes application/domain service interfaces, never raw tables.
 * - AI actions inherit the caller's permissions and are auditable
 *   (`ai.tool_called`, `ai.action_requested`, …).
 * - No provider SDK imports in domain packages; isolate them here.
 */

export const AI_BOUNDARY_VERSION = 0 as const

export type AiContext = {
  workspaceId: string
  actorId: string
  correlationId?: string
}
