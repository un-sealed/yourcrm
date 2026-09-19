import type { Session } from "@yourcrm/auth"
import {
  createAiCrmTools,
  AI_TOOL_DESCRIBE_OBJECTS,
  AI_TOOL_QUERY,
  type AiTool,
  type AiToolRegistry,
} from "@yourcrm/crm/src/ai-assistant"
import { SEARCH_OBJECT_TYPES } from "@yourcrm/crm/src/search"
import { requirePermission, type PermissionAction } from "@yourcrm/permissions"
import type { ServiceContext } from "@yourcrm/validation"
import { z } from "zod"
import { mcpServiceContext, requireMcpSession, type McpSession } from "./auth"
import type { McpRuntime } from "./runtime"

/**
 * The MCP tool catalogue (spec 39-mcp, P0).
 *
 * ## One sentence
 *
 * A tool call is an authenticated person asking a domain service a
 * question — or proposing a change for another person to approve. It is
 * never a query, never a table, and never a write.
 *
 * ## THE FOUR PROPERTIES, and where each is implemented
 *
 * 1. NO PERMISSION BYPASS. {@link createMcpToolset}'s `call` resolves a
 *    real `Session` FIRST, derives the `ServiceContext` from it alone
 *    (`mcpServiceContext`), and calls `requirePermission()` before the
 *    handler runs. The handler then calls a domain service which runs its
 *    OWN `requirePermission()` and its own row scoping. Two independent
 *    gates, neither of which an argument can influence. A viewer asking
 *    `yourcrm_list_deals` gets `scope: "own"` from
 *    `resolveReportRowScope`, exactly as the same viewer would through the
 *    HTTP API — asserted in `tools.test.ts`.
 *
 * 2. NO DIRECT WRITES. Every `propose_*` tool calls
 *    `AiActionProposalPort.requestAction`, which queues an
 *    `ai_action_request` and returns. That port has exactly one method:
 *    there is no `approve` and no `apply` in this process to reach, and an
 *    `actorType: "agent"` context is refused by `assertHumanApprover`
 *    anyway. So an MCP client cannot approve its own proposal even if the
 *    surface grew one. `governance.test.ts` proves a proposal lands
 *    `pending` and the applier is never called.
 *
 * 3. NO TABLE ACCESS. Reads go through the ASSISTANT'S OWN tools
 *    (`createAiCrmTools`) over the reports engine — the same allowlisted,
 *    parameter-bound, row-scoped query path Ask-Your-CRM uses. This module
 *    defines no second query path, and `boundary.test.ts` asserts the
 *    database package is named nowhere in `apps/mcp/src`.
 *
 * 4. UNAUTHENTICATED CALLS ARE REFUSED, uninformatively. `call` refuses
 *    before it looks the tool name up, with the constant
 *    `MCP_UNAUTHORIZED_MESSAGE`, so the refusal cannot be used to probe
 *    which tools — or which records — exist.
 *
 * ## Schemas
 *
 * {@link McpJsonSchema} makes `required` a REQUIRED field of the type, so
 * a parameter-less tool cannot be declared without `required: []`. That is
 * not pedantry: `ai-core` hit a live gateway rejecting a tool schema with
 * `null is not of type "array"` for exactly this omission, and the MCP
 * SDK's zod-to-JSON-Schema conversion drops `required` when no property is
 * required — which is why `index.ts` emits these schemas verbatim instead.
 *
 * ## Events
 *
 * Spec 39 §9 names `mcp.connected`, `mcp.tool_called`, `mcp.write_approved`
 * and `mcp.disconnected`. `@yourcrm/events` exports no constants for them
 * and event names may never be string literals, so no domain events are
 * emitted here; the audit row below covers every call in the meantime.
 * Reported as a blocker rather than papered over.
 */

/* ------------------------------- schemas -------------------------------- */

/**
 * A complete JSON Schema object for a tool's arguments.
 *
 * `required` is not optional at the type level ON PURPOSE — see the header.
 */
export type McpJsonSchema = {
  type: "object"
  properties: Record<string, unknown>
  required: string[]
  additionalProperties: false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Narrow an AI tool's `parameters` (a JSON Schema) into {@link McpJsonSchema}. */
function jsonSchemaOf(parameters: Record<string, unknown>): McpJsonSchema {
  return {
    type: "object",
    properties: isRecord(parameters.properties) ? parameters.properties : {},
    required: Array.isArray(parameters.required)
      ? parameters.required.filter((entry): entry is string => typeof entry === "string")
      : [],
    additionalProperties: false,
  }
}

function withoutProperty(schema: McpJsonSchema, key: string): McpJsonSchema {
  const properties = Object.fromEntries(
    Object.entries(schema.properties).filter(([name]) => name !== key),
  )
  return { ...schema, properties, required: schema.required.filter((name) => name !== key) }
}

const NO_ARGUMENTS: McpJsonSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
}

const rationaleProperty = {
  type: "string",
  minLength: 1,
  maxLength: 4000,
  description:
    "Why this change should happen, in the words you would use to a colleague. A reviewer sees this and nothing else about your reasoning.",
}

/* -------------------------------- tools --------------------------------- */

/** What a handler is given: the caller, and nothing the caller chose. */
export type McpToolInvocation = {
  /** Workspace, actor and role, derived from the session only. */
  service: ServiceContext
  session: Session
  caller: McpSession
}

/** A tool's answer: a JSON payload for the client plus one line for the log. */
export type McpToolOutcome = {
  result: unknown
  /** Never contains record content — it goes into the audit row. */
  summary: string
}

/**
 * `read` tools answer questions; `propose` tools queue a governed change.
 * The distinction drives the permission action each one requires, and it
 * is the reason no third value exists: a tool that writes directly has no
 * access level it could declare.
 */
export type McpToolAccess = "read" | "propose"

export type McpToolDefinition = {
  name: string
  description: string
  inputSchema: McpJsonSchema
  access: McpToolAccess
  handler: (args: Record<string, unknown>, invocation: McpToolInvocation) => Promise<McpToolOutcome>
}

export class McpUnknownToolError extends Error {
  readonly code = "NOT_FOUND"
  constructor(name: string) {
    super(`unknown tool: ${name}`)
    this.name = "McpUnknownToolError"
  }
}

/* ----------------------------- permissions ------------------------------ */

/** The object MCP tool calls are audited and gated against. */
export const MCP_TOOL_OBJECT = "mcp_tool"

/**
 * The module-level gate, on top of (never instead of) the domain service's
 * own check. Reading needs `read`; proposing a change needs `run_ai` — the
 * same permission `ai-governance` requires of anything that queues an AI
 * action, so a viewer cannot propose through MCP any more than through the
 * assistant.
 */
export function mcpToolPermission(ctx: ServiceContext, access: McpToolAccess) {
  const action: PermissionAction = access === "read" ? "read" : "run_ai"
  return {
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    role: ctx.role ?? "viewer",
    object: MCP_TOOL_OBJECT,
    action,
  }
}

/* ------------------------------ read tools ------------------------------ */

function requireAiTool(registry: AiToolRegistry, name: string): AiTool {
  const tool = registry.get(name)
  // Unreachable: `createAiCrmTools` registers both names. Kept as an
  // assertion rather than a `!` so a rename upstream fails loudly here.
  if (!tool) throw new Error(`assistant tool "${name}" is missing from the registry`)
  return tool
}

/** The five objects that get a first-class list tool (spec 39 §3). */
const LIST_TOOLS: { name: string; objectType: string; label: string }[] = [
  { name: "yourcrm_list_people", objectType: "person", label: "people (contacts)" },
  { name: "yourcrm_list_companies", objectType: "company", label: "companies (accounts)" },
  { name: "yourcrm_list_deals", objectType: "deal", label: "deals (opportunities)" },
  { name: "yourcrm_list_tasks", objectType: "task", label: "tasks" },
  { name: "yourcrm_list_activities", objectType: "activity", label: "activities (timeline items)" },
]

const searchArgs = z
  .object({
    query: z.string().trim().min(1).max(255),
    object: z.enum(SEARCH_OBJECT_TYPES).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict()

const searchSchema: McpJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 255,
      description: "Free text. Matches names, titles and indexed record content.",
    },
    object: {
      type: "string",
      enum: [...SEARCH_OBJECT_TYPES],
      description: "Restrict to one object type. Omit to search everything readable.",
    },
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20." },
  },
}

/* ----------------------------- propose tools ---------------------------- */

const proposeCreateArgs = z
  .object({
    objectType: z.string().trim().min(1).max(64),
    values: z.record(z.unknown()),
    rationale: z.string().trim().min(1).max(4000),
    expiresInMinutes: z.number().int().min(1).optional(),
  })
  .strict()

const proposeUpdateArgs = z
  .object({
    objectType: z.string().trim().min(1).max(64),
    recordId: z.string().trim().min(1).max(128),
    before: z.record(z.unknown()),
    after: z.record(z.unknown()),
    rationale: z.string().trim().min(1).max(4000),
    expiresInMinutes: z.number().int().min(1).optional(),
  })
  .strict()

const proposeTaskArgs = z
  .object({
    title: z.string().trim().min(1).max(255),
    dueDate: z.string().trim().min(1).max(64).optional(),
    assigneeId: z.string().trim().min(1).max(128).optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    rationale: z.string().trim().min(1).max(4000),
  })
  .strict()

const proposeCreateSchema: McpJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["objectType", "values", "rationale"],
  properties: {
    objectType: {
      type: "string",
      description:
        "Object to create, e.g. person, company, deal, task, activity. Use yourcrm_describe_objects for the exact field names.",
    },
    values: {
      type: "object",
      description: "Field values the new record would be created with.",
      additionalProperties: true,
    },
    rationale: rationaleProperty,
    expiresInMinutes: {
      type: "integer",
      minimum: 1,
      description: "How long the proposal stays actionable. Defaults to three days.",
    },
  },
}

const proposeUpdateSchema: McpJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["objectType", "recordId", "before", "after", "rationale"],
  properties: {
    objectType: { type: "string", description: "Object the record belongs to, e.g. deal." },
    recordId: { type: "string", description: "Id of the record to change." },
    before: {
      type: "object",
      additionalProperties: true,
      description:
        "The fields as you READ them, for exactly the keys you are changing. A revert restores this, so read the record first — do not guess.",
    },
    after: {
      type: "object",
      additionalProperties: true,
      description: "The same keys with the values you propose.",
    },
    rationale: rationaleProperty,
    expiresInMinutes: { type: "integer", minimum: 1, description: "Defaults to three days." },
  },
}

const proposeTaskSchema: McpJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "rationale"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 255, description: "What must be done." },
    dueDate: { type: "string", description: "ISO-8601 date or date-time." },
    assigneeId: { type: "string", description: "User id to assign to. Defaults to you." },
    priority: { type: "string", enum: ["low", "medium", "high"] },
    rationale: rationaleProperty,
  },
}

/* ------------------------------- toolset -------------------------------- */

export type McpToolset = {
  /** The catalogue, in `tools/list` order. */
  tools: readonly McpToolDefinition[]
  get(name: string): McpToolDefinition | undefined
  /** THE entrypoint. Authenticates, authorizes, runs, audits. */
  call(name: string, args: Record<string, unknown>, caller: McpSession): Promise<McpToolOutcome>
}

function truncate(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function errorCodeOf(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code
    if (typeof code === "string") return code
    return err.name
  }
  return "UNKNOWN"
}

export function createMcpToolset(runtime: McpRuntime): McpToolset {
  /**
   * The assistant's read-only registry, handed the very same reports
   * engine. Going through `createAiCrmTools` rather than the two factories
   * also inherits its gate: the registry REFUSES to hold a non-read tool,
   * so the MCP read path is provably incapable of containing a write.
   */
  const aiTools = createAiCrmTools({ reports: runtime.reports })
  const describeTool = requireAiTool(aiTools, AI_TOOL_DESCRIBE_OBJECTS)
  const queryTool = requireAiTool(aiTools, AI_TOOL_QUERY)
  const querySchema = jsonSchemaOf(queryTool.parameters)
  const listSchema = withoutProperty(querySchema, "objectType")

  const readTools: McpToolDefinition[] = [
    {
      name: "yourcrm_ping",
      description:
        "Check that the CRM is reachable and report who you are connected as: workspace and role. Call this first if a tool refuses you.",
      inputSchema: NO_ARGUMENTS,
      access: "read",
      handler: async (_args, { service }) => ({
        result: {
          pong: true,
          workspaceId: service.workspaceId,
          actorId: service.actorId,
          role: service.role ?? "viewer",
        },
        summary: `connected to ${service.workspaceId} as ${service.role ?? "viewer"}`,
      }),
    },
    {
      name: "yourcrm_describe_objects",
      description:
        "List the CRM objects this workspace can be queried on and the exact field names, types and select options on each. Call this before any list or query tool whenever you are unsure of a field name.",
      inputSchema: NO_ARGUMENTS,
      access: "read",
      handler: async (_args, { service }) => describeTool.execute(service, {}),
    },
    {
      name: "yourcrm_query_records",
      description:
        "Query any CRM object: rows, or aggregates such as counts and sums. Results are already filtered to what you are allowed to see — never claim a number is workspace-wide unless the result says the scope is 'workspace'.",
      inputSchema: querySchema,
      access: "read",
      handler: async (args, { service }) => queryTool.execute(service, args),
    },
    ...LIST_TOOLS.map(
      (entry): McpToolDefinition => ({
        name: entry.name,
        description: `List ${entry.label} with optional filters, sorting and a column selection. Equivalent to yourcrm_query_records with objectType "${entry.objectType}". Results are filtered to what you are allowed to see.`,
        inputSchema: listSchema,
        access: "read",
        // The objectType is fixed HERE, not taken from the arguments, so
        // these tools are a narrowing of the query tool and never a widening.
        handler: async (args, { service }) =>
          queryTool.execute(service, { ...args, objectType: entry.objectType }),
      }),
    ),
    {
      name: "yourcrm_search",
      description:
        "Full-text search across the CRM: people, companies, leads, deals, activities, tasks, files, forms, products and invoices. Use this to find a record by name when you do not know its id. Only records you may read are returned.",
      inputSchema: searchSchema,
      access: "read",
      handler: async (args, { service }) => {
        const input = searchArgs.parse(args)
        const hits = await runtime.search.search(service, input)
        return {
          result: hits,
          summary: `search "${truncate(input.query, 60)}": ${String(hits.data.length)} hit(s)`,
        }
      },
    },
  ]

  /**
   * Every propose tool funnels through here. One call, one port, no
   * alternative: the runtime exposes `requestAction` and nothing else that
   * can touch a record.
   */
  async function propose(
    invocation: McpToolInvocation,
    input: Record<string, unknown>,
    describe: string,
  ): Promise<McpToolOutcome> {
    const outcome = await runtime.governance.requestAction(
      {
        ...invocation.service,
        // An MCP client is a machine acting for a person: the actor is the
        // person (permissions are theirs), the actor TYPE is `agent`, which
        // `assertHumanApprover` uses to refuse it any decision at all.
        actorType: "agent",
        agentId: invocation.caller.clientId,
      },
      input,
    )
    return {
      result: {
        request: outcome.request,
        policyMode: outcome.mode,
        applied: outcome.applied,
        /** Say it plainly so the model does not report a change as done. */
        note:
          outcome.request.status === "pending"
            ? "Queued for human approval. Nothing has changed yet."
            : `The workspace AI policy resolved this to "${outcome.request.status}".`,
      },
      summary: `${describe} -> ai_action_request ${outcome.request.id} (${outcome.request.status})`,
    }
  }

  const proposeTools: McpToolDefinition[] = [
    {
      name: "yourcrm_propose_create_record",
      description:
        "Propose creating a CRM record. This does NOT create anything: it queues the change for a human in the workspace to approve or reject. Tell the user their approval is needed.",
      inputSchema: proposeCreateSchema,
      access: "propose",
      handler: async (args, invocation) => {
        const input = proposeCreateArgs.parse(args)
        return propose(
          invocation,
          {
            objectType: input.objectType,
            action: "create",
            after: input.values,
            rationale: input.rationale,
            ...(input.expiresInMinutes === undefined
              ? {}
              : { expiresInMinutes: input.expiresInMinutes }),
          },
          `propose create ${input.objectType}`,
        )
      },
    },
    {
      name: "yourcrm_propose_update_record",
      description:
        "Propose changing fields on an existing CRM record. This does NOT change anything: it queues the change for a human to approve. Read the record first so `before` is the state you actually saw — a revert restores it.",
      inputSchema: proposeUpdateSchema,
      access: "propose",
      handler: async (args, invocation) => {
        const input = proposeUpdateArgs.parse(args)
        return propose(
          invocation,
          {
            objectType: input.objectType,
            recordId: input.recordId,
            action: "update",
            before: input.before,
            after: input.after,
            rationale: input.rationale,
            ...(input.expiresInMinutes === undefined
              ? {}
              : { expiresInMinutes: input.expiresInMinutes }),
          },
          `propose update ${input.objectType} ${input.recordId}`,
        )
      },
    },
    {
      name: "yourcrm_propose_create_task",
      description:
        "Propose a follow-up task. This does NOT create the task: it queues it for a human to approve. Defaults the assignee to you.",
      inputSchema: proposeTaskSchema,
      access: "propose",
      handler: async (args, invocation) => {
        const input = proposeTaskArgs.parse(args)
        return propose(
          invocation,
          {
            objectType: "task",
            action: "create",
            after: {
              title: input.title,
              assigneeId: input.assigneeId ?? invocation.service.actorId,
              ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
              ...(input.priority === undefined ? {} : { priority: input.priority }),
            },
            rationale: input.rationale,
          },
          `propose create task "${truncate(input.title, 60)}"`,
        )
      },
    },
  ]

  const tools: readonly McpToolDefinition[] = [...readTools, ...proposeTools]
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  /**
   * One audit row per call: caller, tool, arguments and outcome
   * (spec 39 §3 "audit logging", `AGENTS.md` "events + audit").
   * `source: "mcp"` makes the whole MCP surface one query.
   */
  async function audit(
    service: ServiceContext,
    caller: McpSession,
    tool: McpToolDefinition,
    args: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Promise<void> {
    await runtime.audit({
      workspaceId: service.workspaceId,
      actorId: service.actorId,
      action: "tool_call",
      object: MCP_TOOL_OBJECT,
      recordId: tool.name,
      after: {
        tool: tool.name,
        access: tool.access,
        clientId: caller.clientId,
        role: service.role ?? "viewer",
        arguments: args,
        ...after,
      },
      correlationId: service.correlationId ?? null,
      source: "mcp",
    })
  }

  async function call(
    name: string,
    args: Record<string, unknown>,
    caller: McpSession,
  ): Promise<McpToolOutcome> {
    // 1. A real session, or nothing. BEFORE the tool lookup, so a refusal
    //    says nothing about which tools — or records — exist.
    const session = requireMcpSession(caller)
    // 2. Identity comes from the session and only from the session.
    const service = mcpServiceContext(caller, session)
    const tool = byName.get(name)
    if (!tool) throw new McpUnknownToolError(name)

    const startedAt = Date.now()
    let outcome: McpToolOutcome
    try {
      // 3. The module gate, INSIDE the try so a refusal is audited like
      //    any other outcome. The domain service runs its own check after.
      requirePermission(mcpToolPermission(service, tool.access))
      outcome = await tool.handler(args, { service, session, caller })
    } catch (err) {
      // The original failure is what the caller must see; a failure to
      // audit it is logged rather than allowed to mask it.
      await audit(service, caller, tool, args, {
        outcome: errorCodeOf(err) === "FORBIDDEN" ? "denied" : "failed",
        errorCode: errorCodeOf(err),
        durationMs: Date.now() - startedAt,
      }).catch((auditErr: unknown) => {
        console.error("MCP audit write failed:", auditErr)
      })
      throw err
    }
    // A successful call is audited before it is answered: there is no
    // such thing as an unaudited success here.
    await audit(service, caller, tool, args, {
      outcome: "succeeded",
      summary: outcome.summary,
      durationMs: Date.now() - startedAt,
    })
    return outcome
  }

  return { tools, get: (name) => byName.get(name), call }
}
