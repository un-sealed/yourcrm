import type { AiToolDefinition } from "@yourcrm/ai"
import type { AiTool, AiToolExecution, AiToolRegistry } from "../ai-assistant/types"
import type { AiActionProposalPort } from "../ai-governance/types"
import { aiAgentProposeToolArgsSchema } from "./schemas"
import type { AiAgentTool, AiAgentToolContext, AiAgentToolRegistry } from "./types"

/**
 * An agent's tools (spec 36-ai-agents, P0).
 *
 * ## Reads happen. Writes are proposed. There is no third case.
 *
 * The read tools are the ASSISTANT's, unwrapped and unmodified
 * (`../ai-assistant/tools.ts`): `crm_describe_objects` and `crm_query`,
 * both of which call `requirePermission()` for the calling context and
 * run through the reports engine's allowlist under that caller's row
 * scope. This module adds no query path of its own — there is exactly one
 * way for AI to read CRM data in this product, and it was already built.
 *
 * The one tool this module does add is `crm_propose_change`, and it
 * changes nothing. It calls `AiActionProposalPort.requestAction`, which
 * records an `ai_action_request` and returns. A human decides later; the
 * apply path lives behind an approval, a live permission intersection and
 * a database claim, none of which an agent can reach
 * (`../ai-governance/service.ts`).
 *
 * ## Why the write tool cannot be smuggled in
 *
 *  - {@link createAiAgentToolRegistry} takes an `AiToolRegistry` for
 *    reads. Building one already throws on any tool whose `access` is not
 *    `"read"` (`createAiToolRegistry`), so a mutating tool cannot even be
 *    handed to an agent.
 *  - Agent-side tools carry `access: "read" | "propose"` and
 *    {@link assertAiAgentToolAccess} refuses anything else. `"propose"`
 *    tools are built here and here only, from a port whose sole method is
 *    `requestAction`.
 *  - The service's dependency list (`AiAgentServiceDeps`) contains no
 *    applier, no domain service and no repository, so even a hostile tool
 *    would have nothing to call. A test asserts that surface.
 */

/** Raised at registry construction, never at runtime — see the header. */
export class AiAgentWriteToolNotAllowedError extends Error {
  readonly code = "AI_AGENT_WRITE_TOOL_NOT_ALLOWED"
  constructor(name: string, access: string) {
    super(
      `ai agent tool "${name}" has access '${access}': an agent may only read directly or propose a change for human approval (spec 38-ai-governance)`,
    )
    this.name = "AiAgentWriteToolNotAllowedError"
  }
}

export const AI_AGENT_TOOL_PROPOSE = "crm_propose_change"

/** The gate. Anything that is not a read or a proposal is refused. */
export function assertAiAgentToolAccess(tool: {
  name: string
  access: string
}): asserts tool is { name: string; access: "read" | "propose" } {
  if (tool.access !== "read" && tool.access !== "propose") {
    throw new AiAgentWriteToolNotAllowedError(tool.name, tool.access)
  }
}

/**
 * Wrap one assistant read tool as an agent tool. The context widens
 * (agents add run attribution) but the tool sees the same
 * `ServiceContext` it always did, and still runs its own
 * `requirePermission()`.
 */
export function toAiAgentReadTool(tool: AiTool): AiAgentTool {
  assertAiAgentToolAccess(tool)
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    access: "read",
    execute: (ctx: AiAgentToolContext, args: Record<string, unknown>) => tool.execute(ctx, args),
  }
}

/**
 * THE WRITE TOOL THAT DOES NOT WRITE.
 *
 * Every field of the proposal is data: the target, the diff the human
 * will see, and the rationale (mandatory — an AI change nobody can
 * explain is not one a human can meaningfully approve). Attribution is
 * taken from the run context, never from the model: `agentId`, `runId`
 * and `model` are what make the queued request traceable back to the
 * exact execution that asked for it.
 *
 * `actorType: "agent"` is what tells the governance service this is a
 * machine. That context is refused by every decision method there, so the
 * agent cannot approve its own proposal — or anyone else's.
 */
export function createAiAgentProposalTool(deps: { proposals: AiActionProposalPort }): AiAgentTool {
  return {
    name: AI_AGENT_TOOL_PROPOSE,
    access: "propose",
    description:
      "Propose a change to a CRM record for human approval. This does NOT change anything: it queues the change for a person to review, approve or reject. Use it whenever the task requires creating, updating, deleting or sending something. Always explain your reasoning in `rationale`, and include the current values in `before` so the reviewer sees a diff.",
    /**
     * A complete JSON Schema object — `type`, `properties`, `required`,
     * `additionalProperties` — because some OpenAI-compatible gateways
     * validate the function schema and reject a partial one. Same note as
     * the assistant's tools.
     */
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["objectType", "action", "rationale"],
      properties: {
        objectType: {
          type: "string",
          description: "Object to change, e.g. person, company, deal, lead, task.",
        },
        recordId: {
          type: "string",
          description:
            "The record to change. Required for update, delete and send_external; omit for create.",
        },
        action: {
          type: "string",
          enum: ["create", "update", "delete", "send_external"],
        },
        before: {
          type: "object",
          additionalProperties: true,
          description:
            "The current values of the fields you want to change, exactly as you read them. Required for update and delete: this is what an undo restores.",
        },
        after: {
          type: "object",
          additionalProperties: true,
          description:
            "The values you want written. Required for create and update. Include only the fields that change.",
        },
        rationale: {
          type: "string",
          description: "Why this change should happen, in one or two sentences, for the reviewer.",
        },
      },
    },
    execute: async (ctx: AiAgentToolContext, rawArgs: Record<string, unknown>) => {
      // Shape gate only. `requestAction` runs the authoritative schema,
      // re-resolves the owner's LIVE role and checks the TARGET action —
      // so an agent cannot even queue what its owner could not do by hand.
      const args = aiAgentProposeToolArgsSchema.parse(rawArgs)
      const outcome = await deps.proposals.requestAction(
        {
          workspaceId: ctx.workspaceId,
          actorId: ctx.actorId,
          role: ctx.role,
          ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
          actorType: "agent",
          agentId: ctx.agentId,
        },
        {
          objectType: args.objectType,
          recordId: args.recordId ?? null,
          action: args.action,
          ...(args.before === undefined ? {} : { before: args.before }),
          ...(args.after === undefined ? {} : { after: args.after }),
          rationale: args.rationale,
          model: ctx.model,
          runId: ctx.runId,
          agentId: ctx.agentId,
        },
      )
      const status = String(outcome.request.status)
      const execution: AiToolExecution = {
        result: {
          requestId: outcome.request.id,
          status,
          policyMode: outcome.mode,
          applied: outcome.applied,
          /** Say it plainly, so the model does not report it as done. */
          message:
            status === "pending"
              ? "Queued for human approval. Nothing has changed yet and you cannot approve it yourself."
              : `The workspace policy recorded this proposal as '${status}'.`,
        },
        summary: `Proposed ${args.action} on ${args.objectType}${
          args.recordId == null ? "" : ` ${args.recordId}`
        } — ${status}`,
      }
      return execution
    },
  }
}

/* ------------------------------- the registry ----------------------------- */

/**
 * Build the registry an agent draws its allowlist from: every read tool
 * the assistant offers, plus the proposal tool when a governance port is
 * wired. A deployment that does not wire one simply has no way to propose
 * anything — which is the safe direction, not a degraded mode.
 */
export function createAiAgentToolRegistry(input: {
  readTools: AiToolRegistry
  proposals?: AiActionProposalPort
}): AiAgentToolRegistry {
  const byName = new Map<string, AiAgentTool>()
  for (const tool of input.readTools.list()) {
    const wrapped = toAiAgentReadTool(tool)
    byName.set(wrapped.name, wrapped)
  }
  if (input.proposals) {
    const proposal = createAiAgentProposalTool({ proposals: input.proposals })
    assertAiAgentToolAccess(proposal)
    byName.set(proposal.name, proposal)
  }

  function subset(names: readonly string[]): AiAgentTool[] {
    const allowed = new Set(names)
    return [...byName.values()].filter((tool) => allowed.has(tool.name))
  }

  return {
    list: () => [...byName.values()],
    get: (name) => byName.get(name) ?? null,
    names: () => [...byName.keys()],
    subset,
    definitions: (names): AiToolDefinition[] =>
      subset(names).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
  }
}
