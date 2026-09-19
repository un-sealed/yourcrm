import * as React from "react"
import { Button } from "./button"
import { DatePicker } from "./date-picker"
import { Select } from "./select"
import { TextField } from "./text-field"
import { cn } from "./utils"

/* ------------------------------------------------------------------ */
/* Filter tree (shared contract: API agents encode this in query strings) */
/* ------------------------------------------------------------------ */

export type FilterCombinator = "and" | "or"

export type FilterOperator =
  | "eq"
  | "neq"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "notIn"
  | "isEmpty"
  | "isNotEmpty"
  | "between"

export type FilterFieldType = "text" | "number" | "date" | "boolean" | "select"

export interface FilterFieldDef {
  name: string
  label: string
  type: FilterFieldType
  options?: { value: string; label: string }[]
}

export interface FilterCondition {
  type: "condition"
  id: string
  field: string
  operator: FilterOperator
  value: unknown
}

export interface FilterGroup {
  type: "group"
  id: string
  combinator: FilterCombinator
  children: FilterNode[]
}

export type FilterNode = FilterCondition | FilterGroup

/** Root of every filter: a group of conditions and (one level of) sub-groups. */
export type FilterTree = FilterGroup

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: "is",
  neq: "is not",
  contains: "contains",
  startsWith: "starts with",
  endsWith: "ends with",
  gt: "greater than",
  gte: "greater than or equal",
  lt: "less than",
  lte: "less than or equal",
  in: "is any of",
  notIn: "is none of",
  isEmpty: "is empty",
  isNotEmpty: "is not empty",
  between: "between",
}

const ALL_OPERATORS = Object.keys(OPERATOR_LABELS) as FilterOperator[]

const OPERATORS_BY_TYPE: Record<FilterFieldType, FilterOperator[]> = {
  text: ["eq", "neq", "contains", "startsWith", "endsWith", "isEmpty", "isNotEmpty"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "isEmpty", "isNotEmpty"],
  date: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "isEmpty", "isNotEmpty"],
  boolean: ["eq", "neq"],
  select: ["eq", "neq", "in", "notIn", "isEmpty", "isNotEmpty"],
}

/** Operators valid for a field type (drives the operator dropdown). */
export function operatorsForFieldType(type: FilterFieldType): FilterOperator[] {
  return [...(OPERATORS_BY_TYPE[type] ?? [])]
}

let filterIdCounter = 0

/** Deterministic id generator for conditions/groups (test-friendly). */
export function createFilterId(prefix = "filter"): string {
  filterIdCounter += 1
  return `${prefix}-${filterIdCounter}`
}

export function createFilterCondition(
  field = "",
  operator: FilterOperator = "eq",
  id = createFilterId("condition"),
): FilterCondition {
  return { type: "condition", id, field, operator, value: "" }
}

export function createFilterGroup(
  combinator: FilterCombinator = "and",
  id = createFilterId("group"),
): FilterGroup {
  return { type: "group", id, combinator, children: [] }
}

/** Empty root tree: match everything until the caller adds conditions. */
export function emptyFilterTree(id = createFilterId("group")): FilterTree {
  return { type: "group", id, combinator: "and", children: [] }
}

export function isFilterCondition(node: FilterNode): node is FilterCondition {
  return node.type === "condition"
}

function mapNode(tree: FilterTree, id: string, map: (node: FilterNode) => FilterNode): FilterTree {
  const visit = (node: FilterNode): FilterNode => {
    const mapped = node.id === id ? map(node) : node
    if (mapped.type === "group") {
      return { ...mapped, children: mapped.children.map((child) => visit(child)) }
    }
    return mapped
  }
  return visit(tree) as FilterTree
}

/** Replace the node with `id` by the result of `updater`. */
export function updateFilterNode(
  tree: FilterTree,
  id: string,
  updater: (node: FilterNode) => FilterNode,
): FilterTree {
  return mapNode(tree, id, updater)
}

/** Remove the node (condition or nested group) with `id`. Root is never removed. */
export function removeFilterNode(tree: FilterTree, id: string): FilterTree {
  if (tree.id === id) {
    return tree
  }
  const visit = (group: FilterGroup): FilterGroup => ({
    ...group,
    children: group.children
      .filter((child) => child.id !== id)
      .map((child) => (child.type === "group" ? visit(child) : child)),
  })
  return visit(tree)
}

/** Append `node` to the group with `groupId` (root or one nested level). */
export function addFilterNode(tree: FilterTree, groupId: string, node: FilterNode): FilterTree {
  return mapNode(tree, groupId, (target) =>
    target.type === "group" ? { ...target, children: [...target.children, node] } : target,
  )
}

/** Switch a group's combinator between AND and OR. */
export function setGroupCombinator(
  tree: FilterTree,
  groupId: string,
  combinator: FilterCombinator,
): FilterTree {
  return mapNode(tree, groupId, (target) =>
    target.type === "group" ? { ...target, children: [...target.children], combinator } : target,
  )
}

/* ------------------------- query-string codec ------------------------- */

function utf8ToBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const host = globalThis as {
    Buffer?: { from: (data: Uint8Array) => { toString: (encoding: string) => string } }
  }
  if (host.Buffer !== undefined) {
    return host.Buffer.from(bytes).toString("base64url")
  }
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function base64UrlToUtf8(input: string): string {
  const host = globalThis as {
    Buffer?: {
      from: (data: string, encoding: string) => { toString: (encoding: string) => string }
    }
  }
  if (host.Buffer !== undefined) {
    return host.Buffer.from(input, "base64url").toString("utf8")
  }
  const padded = input.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index) as number
  }
  return new TextDecoder().decode(bytes)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFilterTree(value: unknown): value is FilterTree {
  if (!isRecord(value) || value["type"] !== "group") {
    return false
  }
  const combinator = value["combinator"]
  if (combinator !== "and" && combinator !== "or") {
    return false
  }
  if (typeof value["id"] !== "string" || !Array.isArray(value["children"])) {
    return false
  }
  return (value["children"] as unknown[]).every((child) => {
    if (!isRecord(child) || typeof child["id"] !== "string") {
      return false
    }
    if (child["type"] === "condition") {
      return (
        typeof child["field"] === "string" &&
        typeof child["operator"] === "string" &&
        (ALL_OPERATORS as string[]).includes(child["operator"]) &&
        "value" in child
      )
    }
    if (child["type"] === "group") {
      return isFilterTree(child)
    }
    return false
  })
}

/**
 * Serialize a filter tree for a URL query string (`?filter=<encoded>`).
 * Compact base64url of the JSON tree.
 */
export function encodeFilterTree(tree: FilterTree): string {
  return utf8ToBase64Url(JSON.stringify(tree))
}

/** Parse `encodeFilterTree` output. Throws on malformed or invalid trees. */
export function decodeFilterTree(encoded: string): FilterTree {
  let parsed: unknown
  try {
    parsed = JSON.parse(base64UrlToUtf8(encoded)) as unknown
  } catch {
    throw new Error("Invalid filter encoding")
  }
  if (!isFilterTree(parsed)) {
    throw new Error("Invalid filter tree")
  }
  return parsed
}

/* --------------------------------- UI --------------------------------- */

export interface FilterBuilderProps {
  value: FilterTree
  onChange: (tree: FilterTree) => void
  fields: FilterFieldDef[]
  className?: string
}

function toValueString(value: unknown): string {
  if (typeof value === "string") {
    return value
  }
  if (value === null || value === undefined) {
    return ""
  }
  return String(value)
}

function fieldFor(fields: FilterFieldDef[], name: string): FilterFieldDef | undefined {
  return fields.find((field) => field.name === name)
}

interface ValueEditorProps {
  field: FilterFieldDef
  operator: FilterOperator
  value: unknown
  onChange: (value: unknown) => void
}

function ValueEditor({
  field,
  operator,
  value,
  onChange,
}: ValueEditorProps): React.ReactElement | null {
  if (operator === "isEmpty" || operator === "isNotEmpty") {
    return null
  }
  const label = `Filter value for ${field.label}`
  if (operator === "between") {
    const pair = Array.isArray(value) ? (value as unknown[]) : []
    const [min, max] = [toValueString(pair[0]), toValueString(pair[1])]
    const inputType = field.type === "number" ? "number" : field.type === "date" ? "date" : "text"
    return (
      <span className="flex items-center gap-1">
        <TextField
          type={inputType}
          value={min}
          aria-label={`${label} minimum`}
          className="h-8 w-28 text-xs"
          onChange={(event) => onChange([event.currentTarget.value, max])}
        />
        <span aria-hidden="true" className="text-xs text-muted-foreground">
          and
        </span>
        <TextField
          type={inputType}
          value={max}
          aria-label={`${label} maximum`}
          className="h-8 w-28 text-xs"
          onChange={(event) => onChange([min, event.currentTarget.value])}
        />
      </span>
    )
  }
  if (field.type === "boolean") {
    return (
      <Select
        aria-label={label}
        className="h-8 w-28 text-xs"
        value={toValueString(value)}
        onChange={(event) => onChange(event.currentTarget.value === "true")}
        options={[
          { value: "true", label: "True" },
          { value: "false", label: "False" },
        ]}
      />
    )
  }
  if (field.type === "select") {
    return (
      <Select
        aria-label={label}
        className="h-8 min-w-28 text-xs"
        value={toValueString(value)}
        onChange={(event) => onChange(event.currentTarget.value)}
        options={field.options ?? []}
      />
    )
  }
  if (field.type === "number") {
    return (
      <TextField
        type="number"
        aria-label={label}
        className="h-8 w-32 text-xs"
        value={toValueString(value)}
        placeholder={operator === "in" || operator === "notIn" ? "1, 2, 3" : undefined}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    )
  }
  if (field.type === "date") {
    return (
      <DatePicker
        aria-label={label}
        className="h-8 w-36 text-xs"
        value={toValueString(value)}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    )
  }
  return (
    <TextField
      aria-label={label}
      className="h-8 min-w-32 text-xs"
      value={toValueString(value)}
      placeholder={operator === "in" || operator === "notIn" ? "a, b, c" : undefined}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  )
}

interface ConditionRowProps {
  tree: FilterTree
  condition: FilterCondition
  onChange: (tree: FilterTree) => void
  fields: FilterFieldDef[]
}

function ConditionRow({
  tree,
  condition,
  onChange,
  fields,
}: ConditionRowProps): React.ReactElement {
  const field = fieldFor(fields, condition.field) ?? fields[0]
  const operators = field !== undefined ? operatorsForFieldType(field.type) : []
  return (
    <div data-slot="filter-condition" className="flex flex-wrap items-center gap-1.5">
      <Select
        aria-label="Field"
        className="h-8 w-36 text-xs"
        value={condition.field}
        onChange={(event) => {
          const next = fieldFor(fields, event.currentTarget.value)
          const nextOperators = next !== undefined ? operatorsForFieldType(next.type) : []
          const fallback = nextOperators[0] ?? "eq"
          onChange(
            updateFilterNode(tree, condition.id, (node) =>
              node.type === "condition"
                ? {
                    ...node,
                    field: event.currentTarget.value,
                    operator: nextOperators.includes(node.operator) ? node.operator : fallback,
                  }
                : node,
            ),
          )
        }}
        options={fields.map((candidate) => ({ value: candidate.name, label: candidate.label }))}
      />
      <Select
        aria-label="Operator"
        className="h-8 w-36 text-xs"
        value={condition.operator}
        onChange={(event) =>
          onChange(
            updateFilterNode(tree, condition.id, (node) =>
              node.type === "condition"
                ? { ...node, operator: event.currentTarget.value as FilterOperator }
                : node,
            ),
          )
        }
        options={operators.map((operator) => ({
          value: operator,
          label: OPERATOR_LABELS[operator],
        }))}
      />
      {field !== undefined ? (
        <ValueEditor
          field={field}
          operator={condition.operator}
          value={condition.value}
          onChange={(value) =>
            onChange(
              updateFilterNode(tree, condition.id, (node) =>
                node.type === "condition" ? { ...node, value } : node,
              ),
            )
          }
        />
      ) : null}
      <button
        type="button"
        aria-label="Remove condition"
        onClick={() => onChange(removeFilterNode(tree, condition.id))}
        className="rounded p-1 text-xs text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        ✕
      </button>
    </div>
  )
}

interface GroupViewProps {
  tree: FilterTree
  group: FilterGroup
  depth: number
  onChange: (tree: FilterTree) => void
  fields: FilterFieldDef[]
  onRemove?: () => void
}

function GroupView({
  tree,
  group,
  depth,
  onChange,
  fields,
  onRemove,
}: GroupViewProps): React.ReactElement {
  const defaultField = fields[0]
  return (
    <div
      data-slot="filter-group"
      className={cn(
        "flex flex-col gap-2 rounded-md border border-border bg-background p-2",
        depth > 0 && "border-dashed bg-muted/30",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <div
          role="group"
          aria-label="Match"
          className="flex overflow-hidden rounded-md border border-border"
        >
          {(["and", "or"] as FilterCombinator[]).map((combinator) => (
            <button
              key={combinator}
              type="button"
              aria-pressed={group.combinator === combinator}
              onClick={() => onChange(setGroupCombinator(tree, group.id, combinator))}
              className={cn(
                "px-2 py-1 text-xs font-medium uppercase focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                group.combinator === combinator
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              {combinator}
            </button>
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={defaultField === undefined}
          onClick={() => {
            if (defaultField !== undefined) {
              onChange(
                addFilterNode(
                  tree,
                  group.id,
                  createFilterCondition(
                    defaultField.name,
                    operatorsForFieldType(defaultField.type)[0] ?? "eq",
                  ),
                ),
              )
            }
          }}
        >
          + Condition
        </Button>
        {depth === 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onChange(addFilterNode(tree, group.id, createFilterGroup("or")))}
          >
            + Group
          </Button>
        ) : null}
        {onRemove !== undefined ? (
          <button
            type="button"
            aria-label="Remove group"
            onClick={onRemove}
            className="rounded p-1 text-xs text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            ✕
          </button>
        ) : null}
      </div>
      {group.children.length === 0 ? (
        <p className="text-xs text-muted-foreground">No conditions — matches everything.</p>
      ) : null}
      {group.children.map((child) =>
        child.type === "condition" ? (
          <ConditionRow
            key={child.id}
            tree={tree}
            condition={child}
            onChange={onChange}
            fields={fields}
          />
        ) : (
          <GroupView
            key={child.id}
            tree={tree}
            group={child}
            depth={depth + 1}
            onChange={onChange}
            fields={fields}
            onRemove={() => onChange(removeFilterNode(tree, child.id))}
          />
        ),
      )}
    </div>
  )
}

/**
 * Visual query builder emitting a serializable `FilterTree`.
 * AND/OR groups nest one level; API agents persist the tree with
 * `encodeFilterTree` in query strings and restore it with `decodeFilterTree`.
 */
export function FilterBuilder({
  value,
  onChange,
  fields,
  className,
}: FilterBuilderProps): React.ReactElement {
  return (
    <div data-slot="filter-builder" className={cn("flex flex-col gap-2", className)}>
      <GroupView tree={value} group={value} depth={0} onChange={onChange} fields={fields} />
    </div>
  )
}
