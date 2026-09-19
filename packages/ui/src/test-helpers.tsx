import * as React from "react"

/**
 * Minimal static renderer for `bun:test`.
 *
 * `packages/ui` ships zero test dependencies (no DOM, no react-dom, no
 * testing-library — and agents may not add any), so component tests expand
 * React elements to plain `StaticNode` trees instead of a DOM. Function
 * components that use hooks cannot be invoked without a renderer; those
 * resolve to a `component:<Name>` placeholder node, and their interaction
 * logic is covered through exported pure helpers + `React.isValidElement`
 * smoke tests.
 */

export interface StaticNode {
  type: string
  props: Record<string, unknown>
  children: StaticNode[]
}

function textNode(value: string): StaticNode {
  return { type: "#text", props: { value }, children: [] }
}

function copyProps(
  props: Record<string, unknown>,
  includeChildren: boolean,
): Record<string, unknown> {
  // NB: never read `key`/`ref` — React dev defines warning getters for them.
  const copy: Record<string, unknown> = {}
  for (const name of Object.keys(props)) {
    if (name === "key" || name === "ref" || (!includeChildren && name === "children")) {
      continue
    }
    copy[name] = props[name]
  }
  return copy
}

function invokeQuietly(
  render: (props: Record<string, unknown>) => React.ReactNode,
  props: Record<string, unknown>,
): React.ReactNode {
  // Hook-using components throw without a renderer (by design); keep the
  // expected React dev nag out of `bun test` output.
  const original = console.error
  console.error = () => undefined
  try {
    return render(copyProps(props, true))
  } finally {
    console.error = original
  }
}

type RenderFn = (props: Record<string, unknown>) => React.ReactNode

function resolveRenderFunction(type: unknown): { render: RenderFn; name: string } | null {
  if (typeof type === "function") {
    const fn = type as RenderFn & { displayName?: string }
    return { render: fn, name: fn.displayName ?? fn.name ?? "Component" }
  }
  if (typeof type === "object" && type !== null) {
    const maybe = type as { render?: unknown; type?: unknown; displayName?: string }
    if (typeof maybe.render === "function") {
      const inner = maybe.render as (
        props: Record<string, unknown>,
        ref: unknown,
      ) => React.ReactNode
      return { render: (props) => inner(props, undefined), name: maybe.displayName ?? "Component" }
    }
    if (maybe.type !== undefined) {
      const resolved = resolveRenderFunction(maybe.type)
      if (resolved !== null) {
        return { ...resolved, name: maybe.displayName ?? resolved.name }
      }
    }
  }
  return null
}

/** Expand a React node into plain static nodes, invoking hook-free components. */
export function expand(node: React.ReactNode): StaticNode[] {
  if (node === null || node === undefined || typeof node === "boolean") {
    return []
  }
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") {
    return [textNode(String(node))]
  }
  if (Array.isArray(node)) {
    return node.flatMap((child) => expand(child))
  }
  if (!React.isValidElement(node)) {
    return []
  }
  const props = (node.props ?? {}) as Record<string, unknown>
  const { type } = node
  if (typeof type === "string") {
    return [
      {
        type,
        props: copyProps(props, false),
        children: expand(props["children"] as React.ReactNode),
      },
    ]
  }
  if (type === React.Fragment) {
    return expand(props["children"] as React.ReactNode)
  }
  const resolved = resolveRenderFunction(type)
  if (resolved === null) {
    return [{ type: "unknown", props: {}, children: [] }]
  }
  try {
    return expand(invokeQuietly(resolved.render, props))
  } catch {
    return [{ type: `component:${resolved.name}`, props: copyProps(props, false), children: [] }]
  }
}

/** Assert a tree has exactly one root and return it. */
export function only(nodes: StaticNode[]): StaticNode {
  if (nodes.length !== 1) {
    throw new Error(`Expected exactly one root node, received ${nodes.length}`)
  }
  return nodes[0] as StaticNode
}

/** Depth-first search over a static tree. */
export function findAll(
  nodes: StaticNode[],
  predicate: (node: StaticNode) => boolean,
): StaticNode[] {
  const found: StaticNode[] = []
  const visit = (node: StaticNode): void => {
    if (predicate(node)) {
      found.push(node)
    }
    for (const child of node.children) {
      visit(child)
    }
  }
  for (const node of nodes) {
    visit(node)
  }
  return found
}

/** Concatenated text content of a node and its descendants. */
export function textOf(node: StaticNode): string {
  if (node.type === "#text") {
    return String(node.props["value"] ?? "")
  }
  return node.children.map((child) => textOf(child)).join("")
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

const VOID_ELEMENTS = new Set(["input", "img", "br", "hr", "meta", "link"])

const BOOLEAN_ATTRIBUTES = new Set([
  "disabled",
  "checked",
  "required",
  "readonly",
  "multiple",
  "selected",
  "open",
  "hidden",
  "autofocus",
])

function styleToString(style: unknown): string | null {
  if (typeof style !== "object" || style === null) {
    return null
  }
  const entries = Object.entries(style as Record<string, unknown>)
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([key, value]) => {
      const kebab = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
      return `${kebab}:${String(value)}`
    })
  return entries.length > 0 ? entries.join(";") : null
}

function serializeAttributes(props: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || key === "dangerouslySetInnerHTML") {
      continue
    }
    if (typeof value === "function" || value === undefined || value === null || key === "ref") {
      continue
    }
    if (key === "className") {
      parts.push(`class="${escapeHtml(String(value))}"`)
      continue
    }
    if (key === "htmlFor") {
      parts.push(`for="${escapeHtml(String(value))}"`)
      continue
    }
    if (key === "tabIndex") {
      parts.push(`tabindex="${escapeHtml(String(value))}"`)
      continue
    }
    if (key === "dateTime") {
      parts.push(`datetime="${escapeHtml(String(value))}"`)
      continue
    }
    if (key === "readOnly") {
      if (value === true) {
        parts.push("readonly")
      }
      continue
    }
    if (key === "autoFocus") {
      if (value === true) {
        parts.push("autofocus")
      }
      continue
    }
    if (key === "style") {
      const serialized = styleToString(value)
      if (serialized !== null) {
        parts.push(`style="${escapeHtml(serialized)}"`)
      }
      continue
    }
    if (
      key.startsWith("aria-") ||
      key.startsWith("data-") ||
      key === "role" ||
      key === "id" ||
      key === "name" ||
      key === "type" ||
      key === "value" ||
      key === "placeholder" ||
      key === "href" ||
      key === "title" ||
      key === "alt" ||
      key === "src" ||
      key === "for" ||
      key === "rows" ||
      key === "cols" ||
      key === "width" ||
      key === "datetime"
    ) {
      if (typeof value === "boolean") {
        parts.push(`${key}="${value ? "true" : "false"}"`)
        continue
      }
      if (typeof value === "string" || typeof value === "number") {
        parts.push(`${key}="${escapeHtml(String(value))}"`)
      }
      continue
    }
    if (BOOLEAN_ATTRIBUTES.has(key) && value === true) {
      parts.push(key)
    }
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : ""
}

function serializeNode(node: StaticNode): string {
  if (node.type === "#text") {
    return escapeHtml(String(node.props["value"] ?? ""))
  }
  if (node.type.startsWith("component:") || node.type === "unknown") {
    return `<!--${node.type}-->`
  }
  const attrs = serializeAttributes(node.props)
  if (VOID_ELEMENTS.has(node.type)) {
    return `<${node.type}${attrs}>`
  }
  const inner = node.children.map((child) => serializeNode(child)).join("")
  return `<${node.type}${attrs}>${inner}</${node.type}>`
}

/** Serialize an element (or tree) to an HTML string for content assertions. */
export function html(node: React.ReactNode): string {
  return expand(node)
    .map((root) => serializeNode(root))
    .join("")
}
