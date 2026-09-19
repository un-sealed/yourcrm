import { AiEvents, createEvent, getEventBus } from "@yourcrm/events"
import { PermissionDeniedError, requirePermission } from "@yourcrm/permissions"
import { redactIntegrationSecrets } from "../integrations/service"
import {
  AI_CONVERSATION_OBJECT,
  AI_RUN_OBJECT,
  AI_TOOL_CALL_OBJECT,
  aiPermission,
  assertAiConversationVisible,
  resolveAiConversationScope,
} from "./access"
import {
  aiConversationQuerySchema,
  askAiSchema,
  createAiConversationSchema,
  updateAiConversationSchema,
} from "./schemas"
import type {
  AiAskResult,
  AiAssistantServiceContext,
  AiAssistantServiceDeps,
  AiCompletionResult,
  AiConversationDetail,
  AiConversationListResult,
  AiConversationRecord,
  AiMessageRecord,
  AiModelPricingTable,
  AiProviderMessage,
  AiProviderStatus,
  AiTokenUsage,
  AiToolCallReport,
} from "./types"

export class AiConversationNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`ai conversation ${id} not found`)
    this.name = "AiConversationNotFoundError"
  }
}

/* ------------------------------ helpers ------------------------------- */

const DEFAULT_MAX_TOOL_ITERATIONS = 4
const DEFAULT_HISTORY_LIMIT = 20
const TOOL_RESULT_MAX_CHARS = 12000
const TITLE_MAX_CHARS = 60

/** Token accounting folded across every provider round-trip in one ask. */
function sumAiTokenUsage(parts: readonly AiTokenUsage[]): AiTokenUsage {
  return parts.reduce<AiTokenUsage>(
    (acc, part) => ({
      promptTokens: acc.promptTokens + part.promptTokens,
      completionTokens: acc.completionTokens + part.completionTokens,
      totalTokens: acc.totalTokens + part.totalTokens,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  )
}

/**
 * Micro-USD for one run, or null when the model has no configured price.
 * Null is honest: a made-up zero would understate spend in the usage views
 * spec 38 builds on this column.
 */
export function computeAiCostMicros(
  pricing: AiModelPricingTable | undefined,
  model: string,
  usage: AiTokenUsage,
): number | null {
  const price = pricing?.[model]
  if (!price) return null
  const input = (usage.promptTokens * price.inputMicrosPerMillion) / 1_000_000
  const output = (usage.completionTokens * price.outputMicrosPerMillion) / 1_000_000
  return Math.round(input + output)
}

/** First line of the question, trimmed — good enough, and never empty. */
export function deriveAiConversationTitle(message: string): string {
  const firstLine = message.split("\n").find((line) => line.trim() !== "") ?? message
  const trimmed = firstLine.trim()
  if (trimmed.length <= TITLE_MAX_CHARS) return trimmed === "" ? "New conversation" : trimmed
  return `${trimmed.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`
}

/**
 * System prompt. Three jobs: tell the model what it is, tell it the things
 * it cannot know (today's date, that results are permission-filtered), and
 * tell it what it may not do (P0 is read-only).
 */
export function buildAiSystemPrompt(input: {
  now: Date
  toolNames: readonly string[]
  suffix?: string | undefined
}): string {
  const lines = [
    "You are the assistant inside YourCRM, a CRM application. You answer questions about the data in this workspace.",
    `Today is ${input.now.toISOString().slice(0, 10)} (UTC). Resolve relative dates such as "last month" against it and pass absolute ISO-8601 dates to tools.`,
    `Use the tools to look data up — never guess a number, a name or a total. Available tools: ${input.toolNames.join(", ")}.`,
    "Tool results are already filtered to what the asking user is allowed to see. When a result reports scope 'own', say the figures cover the user's own records rather than the whole workspace.",
    "If a tool reports a permission error, say plainly that the user does not have access to that data. Never speculate about what the hidden records might contain.",
    "You are read-only: you cannot create, update, delete or send anything. If asked to, explain that write actions are not available yet and suggest the CRM screen where the user can do it themselves.",
    "Answer in plain prose, briefly. Give concrete numbers and names from tool results, and say when a result was empty.",
  ]
  if (input.suffix !== undefined && input.suffix.trim() !== "") lines.push(input.suffix.trim())
  return lines.join("\n")
}

/** Stored rows -> provider messages. See the note in `ask` about tool rows. */
function historyToProviderMessages(messages: readonly AiMessageRecord[]): AiProviderMessage[] {
  const out: AiProviderMessage[] = []
  for (const row of messages) {
    if (row.content === "") continue
    if (row.role === "user") out.push({ role: "user", content: row.content })
    else if (row.role === "assistant") out.push({ role: "assistant", content: row.content })
  }
  return out
}

function serialiseToolResult(value: unknown): string {
  const text = JSON.stringify(value ?? null) ?? "null"
  return text.length > TOOL_RESULT_MAX_CHARS
    ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}…[truncated]`
    : text
}

function errorCodeOf(err: unknown): string {
  const code = (err as { code?: unknown }).code
  return typeof code === "string" ? code : "AI_PROVIDER_UNAVAILABLE"
}

/**
 * Message for a failed run. Redacted with the integrations helper so that a
 * provider that echoed a credential into its error body cannot get it into
 * `ai_runs.error_message`, a log line or an audit row.
 */
function safeErrorMessage(err: unknown, secrets: readonly (string | null | undefined)[]): string {
  const raw = err instanceof Error ? err.message : String(err)
  return redactIntegrationSecrets(raw, ...secrets).slice(0, 500)
}

/* ------------------------------ service ------------------------------- */

/**
 * Ask-Your-CRM assistant (spec 34-ai-assistant, P0).
 *
 * Every method calls `requirePermission()` first, then applies the
 * conversation's own record-level policy (`access.ts`), then works through
 * the injected ports. The interesting method is `ask`:
 *
 *  1. persist the question;
 *  2. loop: provider -> tool calls -> tool results -> provider, bounded by
 *     `maxToolIterations`, with **every tool executed under the asking
 *     user's context** (see `tools.ts`);
 *  3. persist the answer with the model that produced it;
 *  4. record one `ai_runs` row — model, tokens, latency, cost, outcome —
 *     and audit the run plus every individual tool call with `source: "ai"`.
 *
 * P0 is strictly read-only. There is no branch here that writes CRM data;
 * write tools arrive with spec 38-ai-governance's approval queue, and the
 * registry in `tools.ts` is the gate that keeps one from slipping in.
 */
export function createAiAssistantService(deps: AiAssistantServiceDeps) {
  const events = deps.events ?? getEventBus()
  const now = deps.now ?? (() => new Date())
  const newId = deps.newId ?? (() => crypto.randomUUID())
  const maxToolIterations = deps.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS
  const historyLimit = deps.historyLimit ?? DEFAULT_HISTORY_LIMIT

  async function loadOwned(
    ctx: AiAssistantServiceContext,
    id: string,
    action: Parameters<typeof assertAiConversationVisible>[2],
  ): Promise<AiConversationRecord> {
    const conversation = await deps.store.findConversation(ctx.workspaceId, id)
    if (!conversation) throw new AiConversationNotFoundError(id)
    assertAiConversationVisible(ctx, conversation, action)
    return conversation
  }

  async function listConversations(
    ctx: AiAssistantServiceContext,
    rawQuery: unknown,
  ): Promise<AiConversationListResult> {
    requirePermission(aiPermission(ctx, "read"))
    const query = aiConversationQuerySchema.parse(rawQuery ?? {})
    return deps.store.listConversations(ctx.workspaceId, query, resolveAiConversationScope(ctx))
  }

  async function getConversation(
    ctx: AiAssistantServiceContext,
    id: string,
  ): Promise<AiConversationDetail> {
    requirePermission(aiPermission(ctx, "read"))
    const conversation = await loadOwned(ctx, id, "read")
    const [messages, runs] = await Promise.all([
      deps.store.listMessages(ctx.workspaceId, id),
      deps.store.listRuns(ctx.workspaceId, id),
    ])
    return { conversation, messages, runs }
  }

  /**
   * Starting your own chat is a `read` on `ai_conversation`, not a
   * `create` — see the header of `access.ts` for why the read-only
   * assistant must stay reachable by viewers.
   */
  async function createConversation(
    ctx: AiAssistantServiceContext,
    rawInput: unknown = {},
  ): Promise<AiConversationRecord> {
    requirePermission(aiPermission(ctx, "read"))
    const input = createAiConversationSchema.parse(rawInput ?? {})
    const conversation = await deps.store.createConversation(
      ctx.workspaceId,
      { title: input.title ?? "New conversation", model: input.model ?? null },
      ctx.actorId,
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: AI_CONVERSATION_OBJECT,
      recordId: conversation.id,
      after: { id: conversation.id, title: conversation.title },
      correlationId: ctx.correlationId,
      source: "user",
    })
    return conversation
  }

  async function renameConversation(
    ctx: AiAssistantServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<AiConversationRecord> {
    requirePermission(aiPermission(ctx, "update"))
    const patch = updateAiConversationSchema.parse(rawPatch)
    const before = await loadOwned(ctx, id, "update")
    const after = await deps.store.updateConversation(
      ctx.workspaceId,
      id,
      { title: patch.title },
      ctx.actorId,
    )
    if (!after) throw new AiConversationNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: AI_CONVERSATION_OBJECT,
      recordId: id,
      before: { title: before.title },
      after: { title: after.title },
      correlationId: ctx.correlationId,
      source: "user",
    })
    return after
  }

  async function deleteConversation(
    ctx: AiAssistantServiceContext,
    id: string,
  ): Promise<AiConversationRecord> {
    requirePermission(aiPermission(ctx, "update"))
    const before = await loadOwned(ctx, id, "update")
    await deps.store.softDeleteConversation(ctx.workspaceId, id, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: AI_CONVERSATION_OBJECT,
      recordId: id,
      before: { id, title: before.title },
      correlationId: ctx.correlationId,
      source: "user",
    })
    return before
  }

  /** Non-secret provider/tool description for UI attribution. */
  function describeProvider(ctx: AiAssistantServiceContext): AiProviderStatus {
    requirePermission(aiPermission(ctx, "read"))
    return {
      providerId: deps.provider.id,
      model: deps.provider.defaultModel,
      tools: deps.tools.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
    }
  }

  /** Run one tool under the caller's context, never throwing outward. */
  async function runTool(
    ctx: AiAssistantServiceContext,
    call: { id: string; name: string; arguments: Record<string, unknown> },
    runId: string,
    model: string,
  ): Promise<{ report: AiToolCallReport; content: string }> {
    const startedAt = Date.now()
    const tool = deps.tools.get(call.name)
    let outcome: AiToolCallReport["outcome"] = "succeeded"
    let summary: string
    let content: string

    if (!tool) {
      outcome = "failed"
      summary = `Unknown tool ${call.name}`
      content = serialiseToolResult({ error: "unknown_tool", message: summary })
    } else {
      try {
        const execution = await tool.execute(ctx, call.arguments)
        summary = execution.summary
        content = serialiseToolResult(execution.result)
      } catch (err) {
        const denied = err instanceof PermissionDeniedError
        outcome = denied ? "denied" : "failed"
        const message = safeErrorMessage(err, [])
        summary = denied ? `Permission denied for ${call.name}` : `${call.name} failed: ${message}`
        content = serialiseToolResult({
          error: denied ? "permission_denied" : errorCodeOf(err),
          message,
        })
      }
    }

    const report: AiToolCallReport = {
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      outcome,
      summary,
      durationMs: Date.now() - startedAt,
    }

    // Attribution (spec 34 §14): every tool call names its run and model.
    await events.emit(
      createEvent({
        event: AiEvents.ToolCalled,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: AI_TOOL_CALL_OBJECT,
        entityId: runId,
        after: { runId, model, tool: call.name, outcome, durationMs: report.durationMs },
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: `tool.${call.name}`,
      object: AI_TOOL_CALL_OBJECT,
      recordId: runId,
      after: {
        runId,
        model,
        providerId: deps.provider.id,
        tool: call.name,
        arguments: call.arguments,
        outcome,
        durationMs: report.durationMs,
      },
      correlationId: ctx.correlationId,
      source: "ai",
    })
    return { report, content }
  }

  async function ask(ctx: AiAssistantServiceContext, rawInput: unknown): Promise<AiAskResult> {
    requirePermission(aiPermission(ctx, "read"))
    const input = askAiSchema.parse(rawInput)
    const startedAt = now()
    const runId = newId()

    const conversation =
      input.conversationId === null || input.conversationId === undefined
        ? await deps.store.createConversation(
            ctx.workspaceId,
            { title: deriveAiConversationTitle(input.message), model: input.model ?? null },
            ctx.actorId,
          )
        : await loadOwned(ctx, input.conversationId, "read")

    const history = await deps.store.listMessages(ctx.workspaceId, conversation.id, historyLimit)
    const userMessage = await deps.store.appendMessage(
      ctx.workspaceId,
      {
        conversationId: conversation.id,
        role: "user",
        content: input.message,
        actorId: ctx.actorId,
      },
      ctx.actorId,
    )

    const model = input.model ?? undefined
    const toolNames = deps.tools.list().map((tool) => tool.name)
    /**
     * Only user/assistant prose is replayed. Tool rows are deliberately
     * dropped: a provider requires each tool result to follow the assistant
     * turn that requested it, and a truncated window can split that pair.
     * The results themselves are already reflected in the assistant text.
     */
    const working: AiProviderMessage[] = [
      {
        role: "system",
        content: buildAiSystemPrompt({
          now: startedAt,
          toolNames,
          suffix: deps.systemPromptSuffix,
        }),
      },
      ...historyToProviderMessages(history),
      { role: "user", content: input.message },
    ]

    const usageParts: AiTokenUsage[] = []
    const toolReports: AiToolCallReport[] = []
    let latencyMs = 0
    let final: AiCompletionResult | null = null

    try {
      for (let step = 0; step < maxToolIterations; step += 1) {
        const completion = await deps.provider.completeWithTools(
          working,
          deps.tools.definitions(),
          { model, correlationId: ctx.correlationId },
        )
        usageParts.push(completion.usage)
        latencyMs += completion.latencyMs
        if (completion.toolCalls.length === 0) {
          final = completion
          break
        }
        working.push({
          role: "assistant",
          content: completion.text,
          toolCalls: completion.toolCalls,
        })
        await deps.store.appendMessage(
          ctx.workspaceId,
          {
            conversationId: conversation.id,
            role: "assistant",
            content: completion.text,
            model: completion.model,
            providerId: completion.providerId,
            runId,
            toolCalls: completion.toolCalls,
          },
          ctx.actorId,
        )
        for (const call of completion.toolCalls) {
          const { report, content } = await runTool(ctx, call, runId, completion.model)
          toolReports.push(report)
          working.push({
            role: "tool",
            content,
            toolCallId: call.id,
            name: call.name,
          })
          await deps.store.appendMessage(
            ctx.workspaceId,
            {
              conversationId: conversation.id,
              role: "tool",
              content,
              runId,
              toolCallId: call.id,
              toolName: call.name,
              toolCalls: { outcome: report.outcome, summary: report.summary },
            },
            ctx.actorId,
          )
        }
      }

      if (!final) {
        // Budget spent on tools: force a prose answer with the tools closed.
        const closing = await deps.provider.complete(working, {
          model,
          correlationId: ctx.correlationId,
        })
        usageParts.push(closing.usage)
        latencyMs += closing.latencyMs
        final = closing
      }
    } catch (err) {
      const usage = sumAiTokenUsage(usageParts)
      const failed = await deps.store.recordRun(
        ctx.workspaceId,
        {
          id: runId,
          conversationId: conversation.id,
          providerId: deps.provider.id,
          model: model ?? deps.provider.defaultModel,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          latencyMs,
          costMicros: computeAiCostMicros(deps.pricing, model ?? deps.provider.defaultModel, usage),
          outcome: "failed",
          errorCode: errorCodeOf(err),
          errorMessage: safeErrorMessage(err, []),
          toolCallCount: toolReports.length,
          toolCalls: toolReports.map((report) => ({
            name: report.name,
            outcome: report.outcome,
          })),
          correlationId: ctx.correlationId,
          actorId: ctx.actorId,
        },
        ctx.actorId,
      )
      await deps.audit({
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        action: "run",
        object: AI_RUN_OBJECT,
        recordId: failed.id,
        after: {
          conversationId: conversation.id,
          model: failed.model,
          providerId: deps.provider.id,
          outcome: "failed",
          errorCode: errorCodeOf(err),
          toolCallCount: toolReports.length,
        },
        correlationId: ctx.correlationId,
        source: "ai",
      })
      throw err
    }

    const usage = sumAiTokenUsage(usageParts)
    const assistantMessage = await deps.store.appendMessage(
      ctx.workspaceId,
      {
        conversationId: conversation.id,
        role: "assistant",
        content: final.text,
        model: final.model,
        providerId: final.providerId,
        runId,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      },
      ctx.actorId,
    )

    const run = await deps.store.recordRun(
      ctx.workspaceId,
      {
        id: runId,
        conversationId: conversation.id,
        messageId: assistantMessage.id,
        providerId: final.providerId,
        model: final.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        latencyMs,
        costMicros: computeAiCostMicros(deps.pricing, final.model, usage),
        outcome: "succeeded",
        toolCallCount: toolReports.length,
        toolCalls: toolReports.map((report) => ({
          name: report.name,
          outcome: report.outcome,
          durationMs: report.durationMs,
        })),
        correlationId: ctx.correlationId,
        actorId: ctx.actorId,
      },
      ctx.actorId,
    )

    const updated =
      (await deps.store.updateConversation(
        ctx.workspaceId,
        conversation.id,
        { model: final.model, lastMessageAt: now() },
        ctx.actorId,
      )) ?? conversation

    await events.emit(
      createEvent({
        event: AiEvents.AgentCompleted,
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        entityType: AI_RUN_OBJECT,
        entityId: run.id,
        after: {
          conversationId: conversation.id,
          model: final.model,
          providerId: final.providerId,
          totalTokens: usage.totalTokens,
          latencyMs,
          toolCallCount: toolReports.length,
        },
        correlationId: ctx.correlationId,
      }),
    )
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "run",
      object: AI_RUN_OBJECT,
      recordId: run.id,
      after: {
        conversationId: conversation.id,
        messageId: assistantMessage.id,
        model: final.model,
        providerId: final.providerId,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        latencyMs,
        costMicros: run.costMicros ?? null,
        outcome: "succeeded",
        toolCallCount: toolReports.length,
        tools: toolReports.map((report) => ({ name: report.name, outcome: report.outcome })),
      },
      correlationId: ctx.correlationId,
      source: "ai",
    })

    return {
      conversation: updated,
      userMessage,
      assistantMessage,
      run,
      toolCalls: toolReports,
    }
  }

  return {
    listConversations,
    getConversation,
    createConversation,
    renameConversation,
    deleteConversation,
    describeProvider,
    ask,
  }
}

export type AiAssistantService = ReturnType<typeof createAiAssistantService>
