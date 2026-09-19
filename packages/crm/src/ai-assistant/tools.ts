import { requirePermission } from "@yourcrm/permissions"
import { reportPermission, resolveReportRowScope } from "../reports/access"
import type { ReportExecutionRequest, ReportFilterTree } from "../reports/types"
import { aiQueryToolArgsSchema } from "./schemas"
import type {
  AiProviderToolDefinition,
  AiReportQueryPort,
  AiTool,
  AiToolContext,
  AiToolExecution,
  AiToolRegistry,
} from "./types"

/**
 * The assistant's tools (spec 34-ai-assistant, P0).
 *
 * ## Permission inheritance — the whole point of this file
 *
 * A tool is not a back door. Every `execute()` below starts with
 * `requirePermission()` **for the asking user**: the `AiToolContext` handed
 * to a tool is the very `ServiceContext` the HTTP request produced, role
 * included. The model never supplies identity, and no code path lets it
 * widen one:
 *
 *  - the reporting gate (`read` on `report`) decides whether the caller may
 *    use the query engine at all;
 *  - the object gate (`read` on the target object) decides whether they may
 *    read deals, people, …;
 *  - `resolveReportRowScope(ctx)` then narrows the *rows* — workspace-wide
 *    for admins and owners, own records only for everyone else.
 *
 * So the same question asked by an admin and by a viewer runs the same SQL
 * with a different scope predicate, and the viewer's answer is a subset.
 * An AI answer can never reveal a record the asker could not open by hand.
 *
 * ## Why the reports engine and not "AI SQL"
 *
 * Turning intent into a query is solved in this repo: the reports
 * repository compiles a definition against a schema-derived allowlist of
 * objects and fields, binds every value as a parameter, generates its own
 * result aliases and refuses to run without a row scope. The assistant
 * emits that same definition, so it inherits all of it. There is no code
 * path from a model token to SQL text.
 *
 * ## P0 is read-only
 *
 * Every tool declares `access: "read"` and {@link createAiToolRegistry}
 * refuses to register anything else. Write tools belong to spec
 * 38-ai-governance's approval queue: they must enqueue a proposed change
 * for a human instead of applying it. The registry gate is the seam where
 * that policy will be enforced — it is intentionally impossible to add a
 * mutating tool here without touching it.
 */

/** Raised at registry construction, never at runtime — see the header. */
export class AiWriteToolNotAllowedError extends Error {
  readonly code = "AI_WRITE_TOOL_NOT_ALLOWED"
  constructor(name: string) {
    super(
      `ai tool "${name}" is not read-only; write tools must go through the approval queue (spec 38-ai-governance)`,
    )
    this.name = "AiWriteToolNotAllowedError"
  }
}

export const AI_TOOL_DESCRIBE_OBJECTS = "crm_describe_objects"

export const AI_TOOL_QUERY = "crm_query"

/* ------------------------------ registry ------------------------------ */

export function createAiToolRegistry(tools: readonly AiTool[]): AiToolRegistry {
  const byName = new Map<string, AiTool>()
  for (const tool of tools) {
    if (tool.access !== "read") throw new AiWriteToolNotAllowedError(tool.name)
    byName.set(tool.name, tool)
  }
  return {
    list: () => [...byName.values()],
    get: (name) => byName.get(name) ?? null,
    definitions: (): AiProviderToolDefinition[] =>
      [...byName.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
  }
}

/* -------------------------------- tools -------------------------------- */

function conditionsToFilterTree(
  filters: { field: string; operator: string; value?: unknown }[],
  combinator: "and" | "or",
): ReportFilterTree | null {
  if (filters.length === 0) return null
  return {
    type: "group",
    id: "ai_root",
    combinator,
    children: filters.map((filter, index) => ({
      type: "condition" as const,
      id: `ai_${String(index)}`,
      field: filter.field,
      operator: filter.operator,
      ...(filter.value === undefined ? {} : { value: filter.value }),
    })),
  }
}

/** Catalogue tool: tells the model which objects and fields exist. */
export function createAiDescribeObjectsTool(deps: { reports: AiReportQueryPort }): AiTool {
  return {
    name: AI_TOOL_DESCRIBE_OBJECTS,
    access: "read",
    description:
      "List the CRM objects this workspace can be queried on and the exact field names, types and select options available on each. Call this before crm_query whenever you are unsure of a field name.",
    /**
     * `required: []` is not decoration: some OpenAI-compatible gateways
     * validate the function schema and reject a missing `required` with
     * `null is not of type "array"` (seen live against agentrouter). Every
     * tool schema here is therefore a complete JSON Schema object —
     * `type`, `properties`, `required`, `additionalProperties`.
     */
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    execute: async (ctx: AiToolContext): Promise<AiToolExecution> => {
      requirePermission(reportPermission(ctx, "read"))
      const objects = deps.reports.describeObjects()
      return {
        result: { objects },
        summary: `Listed ${String(objects.length)} queryable CRM objects`,
      }
    },
  }
}

/**
 * Query tool: aggregate or list CRM records through the reports engine.
 * Read-only by construction — the port it holds has no write method.
 */
export function createAiQueryTool(deps: { reports: AiReportQueryPort }): AiTool {
  return {
    name: AI_TOOL_QUERY,
    access: "read",
    description:
      "Query CRM records. Returns either rows (omit groupBy and aggregations) or aggregates such as counts and sums (set aggregations, optionally with groupBy). Use crm_describe_objects for valid objectType and field names. Results are already filtered to what the asking user is allowed to see — never claim a number is workspace-wide unless the result says the scope is 'workspace'.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["objectType"],
      properties: {
        objectType: {
          type: "string",
          description: "Object to query, e.g. deal, person, company, lead, task, activity.",
        },
        filters: {
          type: "array",
          maxItems: 20,
          description: "Conditions combined with `combinator`.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["field", "operator"],
            properties: {
              field: { type: "string" },
              operator: {
                type: "string",
                enum: [
                  "eq",
                  "neq",
                  "contains",
                  "startsWith",
                  "endsWith",
                  "gt",
                  "gte",
                  "lt",
                  "lte",
                  "in",
                  "notIn",
                  "isEmpty",
                  "isNotEmpty",
                  "between",
                ],
              },
              value: {
                description:
                  "Scalar for most operators; an array for in, notIn and between. Dates are ISO-8601 strings. Omit for isEmpty and isNotEmpty.",
              },
            },
          },
        },
        combinator: { type: "string", enum: ["and", "or"], description: "Defaults to and." },
        groupBy: { type: "string", description: "Field to group aggregates by." },
        aggregations: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["fn"],
            properties: {
              fn: { type: "string", enum: ["count", "sum", "avg", "min", "max"] },
              field: { type: "string", description: "Required for every function except count." },
              label: { type: "string" },
            },
          },
        },
        columns: {
          type: "array",
          maxItems: 15,
          items: { type: "string" },
          description: "Fields to return when listing rows.",
        },
        sort: {
          type: "array",
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["field", "direction"],
            properties: {
              field: { type: "string" },
              direction: { type: "string", enum: ["asc", "desc"] },
            },
          },
        },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 25." },
      },
    },
    execute: async (ctx: AiToolContext, rawArgs: Record<string, unknown>) => {
      // 1. May the caller use the query engine at all?
      requirePermission(reportPermission(ctx, "read"))
      // 2. Shape gate. Object and field *existence* is the engine's allowlist.
      const args = aiQueryToolArgsSchema.parse(rawArgs)
      // 3. May the caller read this object?
      requirePermission(reportPermission(ctx, "read", args.objectType))
      // 4. Which rows may they see? Derived from the session, never the model.
      const scope = resolveReportRowScope(ctx)

      const request: ReportExecutionRequest = {
        objectType: args.objectType,
        filter: conditionsToFilterTree(args.filters ?? [], args.combinator ?? "and"),
        groupBy: args.groupBy ?? null,
        aggregations:
          args.aggregations === undefined
            ? null
            : args.aggregations.map((entry) => ({
                fn: entry.fn,
                field: entry.field ?? null,
                label: entry.label ?? null,
              })),
        columns:
          args.columns === undefined ? null : args.columns.map((field) => ({ field, label: null })),
        sort: args.sort ?? null,
        limit: args.limit ?? 25,
      }

      const result = await deps.reports.execute(ctx.workspaceId, request, scope)
      return {
        result: {
          objectType: result.objectType,
          mode: result.mode,
          /** `own` means: these numbers cover only the asker's records. */
          scope: result.scope,
          columns: result.columns.map((column) => ({ key: column.key, label: column.label })),
          rows: result.rows,
          rowCount: result.rowCount,
          truncated: result.truncated,
        },
        summary: `${result.objectType}: ${String(result.rowCount)} ${
          result.mode === "grouped" ? "group(s)" : "row(s)"
        } (${result.scope} scope)`,
      }
    },
  }
}

/** The P0 tool set: catalogue + query, both read-only. */
export function createAiCrmTools(deps: { reports: AiReportQueryPort }): AiToolRegistry {
  return createAiToolRegistry([createAiDescribeObjectsTool(deps), createAiQueryTool(deps)])
}
