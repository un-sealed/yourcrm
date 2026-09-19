/**
 * `@yourcrm/ai` — the AI service boundary.
 *
 * WHAT THIS PACKAGE IS
 * --------------------
 * The contract of record for talking to a large language model: the
 * {@link AiProvider} port plus its message, tool, usage and error types.
 * Everything AI-shaped in the product — the Ask-Your-CRM assistant, AI
 * fields, agents, conversation intelligence, MCP tools — is written against
 * this one port and receives a provider by injection.
 *
 * Rules that outlive any single agent:
 * - AI consumes application/domain service interfaces, never raw tables.
 * - AI actions inherit the caller's permissions and are auditable
 *   (`ai.tool_called`, `ai.action_requested`, …), attributable to a model
 *   and a run id.
 * - No provider SDK in domain packages. The only transport is `fetch`
 *   behind this port.
 *
 * WHERE THE IMPLEMENTATIONS ARE
 * -----------------------------
 * `packages/ai` is not a declared dependency of any app or of
 * `packages/crm`, so nothing can import it yet (bun symlinks only declared
 * dependencies). The shipping OpenAI-compatible and stub providers
 * therefore live in `packages/crm/src/ai-assistant/providers/`, written
 * against a byte-identical structural mirror of {@link AiProvider}. See the
 * header of `./provider.ts` for the mechanical move once
 * `"@yourcrm/ai": "workspace:*"` is added to `apps/api` and `packages/crm`.
 */

export { AI_PROVIDER_ERROR_CODES, AiProviderError, emptyAiUsage, sumAiUsage } from "./provider"
export type {
  AiCompleteOptions,
  AiCompletion,
  AiFinishReason,
  AiMessage,
  AiMessageRole,
  AiProvider,
  AiProviderErrorCode,
  AiToolCall,
  AiToolDefinition,
  AiUsage,
} from "./provider"

/**
 * Bumped from 0 to 1 when the placeholder became the real provider
 * contract. Consumers can assert on it to detect a port revision.
 */
export const AI_BOUNDARY_VERSION = 1 as const

/** Call context carried into every AI operation. Mirrors `ServiceContext`. */
export type AiContext = {
  workspaceId: string
  actorId: string
  correlationId?: string
}
