/**
 * Answer formatting for the AI assistant (spec 34-ai-assistant).
 *
 * Two independent problems live here, both pure so they can be tested
 * without rendering React — the same split `types.ts` already makes.
 *
 * 1. **Assistant prose.** The model is asked for plain prose but, like every
 *    chat model, it answers in Markdown. The page used to print
 *    `message.content` into a `whitespace-pre-wrap` div, so a Markdown table
 *    arrived as a stack of pipe-separated lines. `parseAnswerBlocks` turns
 *    the text into a small block tree the view renders as real elements.
 *
 * 2. **Tool results.** Every `role: "tool"` message stores the tool's result
 *    as JSON, and the query tool's result is already a typed dataset —
 *    `{ columns: [{key,label}], rows }` straight from the reports engine.
 *    `parseToolDataset` recovers it so the answer can show the actual table
 *    the model was reading, rather than the model's retelling of it.
 *
 * Deliberately no Markdown dependency: this renders a closed set of blocks
 * to React elements and never produces HTML, so there is no sanitiser to get
 * wrong. The knowledge-base page made the same call ("no markdown/sanitizer
 * dependency was added"), and the chart primitives were hand-written over
 * pulling in a library for the same reason.
 */

export type InlineSpan =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }

export type CellAlign = "left" | "right" | "center"

export type AnswerBlock =
  | { kind: "paragraph"; spans: InlineSpan[] }
  | { kind: "heading"; level: 1 | 2 | 3; spans: InlineSpan[] }
  | { kind: "list"; ordered: boolean; items: InlineSpan[][] }
  | { kind: "code"; language: string | null; code: string }
  | { kind: "table"; headers: string[]; rows: string[][]; aligns: CellAlign[] }

/** Markdown allows h1-h6; the view caps the level at 3 (see `parseAnswerBlocks`). */
const HEADING_RE = /^(#{1,6})\s+(.*)$/
const BULLET_RE = /^\s{0,3}[-*+]\s+(.*)$/
const ORDERED_RE = /^\s{0,3}\d+[.)]\s+(.*)$/
const FENCE_RE = /^\s{0,3}```(.*)$/
/** A GFM delimiter row: `---|:--:|---:`, with or without edge pipes. */
const DELIMITER_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

/**
 * Split one table row on unescaped pipes. `\|` is a literal pipe inside a
 * cell, so splitting naively on `|` would tear such a cell in half and shift
 * every column after it.
 */
export function splitTableRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith("|")) text = text.slice(1)
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1)

  const cells: string[] = []
  let current = ""
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === "\\" && text[i + 1] === "|") {
      current += "|"
      i += 1
      continue
    }
    if (ch === "|") {
      cells.push(current.trim())
      current = ""
      continue
    }
    current += ch
  }
  cells.push(current.trim())
  return cells
}

function alignOf(spec: string): CellAlign {
  const trimmed = spec.trim()
  const left = trimmed.startsWith(":")
  const right = trimmed.endsWith(":")
  if (left && right) return "center"
  if (right) return "right"
  return "left"
}

/** `true` when the text reads as a number, so its column can be right-aligned. */
export function looksNumeric(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === "") return false
  // Tolerate the shapes a CRM actually prints: $1,200.50, 45%, -3, (250).
  const bare = trimmed
    .replace(/^\((.*)\)$/, "-$1")
    .replace(/[$€£¥]/g, "")
    .replace(/,/g, "")
    .replace(/%$/, "")
    .trim()
  return bare !== "" && Number.isFinite(Number(bare))
}

const INLINE_RE = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/g

/** Inline emphasis. Code wins over bold, and bold over italic, by ordering. */
export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = []
  let lastIndex = 0
  INLINE_RE.lastIndex = 0
  let match = INLINE_RE.exec(text)
  while (match !== null) {
    if (match.index > lastIndex) {
      spans.push({ kind: "text", text: text.slice(lastIndex, match.index) })
    }
    const [, code, boldStar, boldUnder, italStar, italUnder] = match
    if (code !== undefined) spans.push({ kind: "code", text: code })
    else if (boldStar !== undefined) spans.push({ kind: "bold", text: boldStar })
    else if (boldUnder !== undefined) spans.push({ kind: "bold", text: boldUnder })
    else if (italStar !== undefined) spans.push({ kind: "italic", text: italStar })
    else if (italUnder !== undefined) spans.push({ kind: "italic", text: italUnder })
    lastIndex = match.index + match[0].length
    match = INLINE_RE.exec(text)
  }
  if (lastIndex < text.length) spans.push({ kind: "text", text: text.slice(lastIndex) })
  if (spans.length === 0) spans.push({ kind: "text", text: "" })
  return spans
}

/**
 * Parse assistant text into renderable blocks. Anything unrecognised stays a
 * paragraph, so an answer is never swallowed by a parse miss — the worst case
 * is the plain text the page showed before.
 */
export function parseAnswerBlocks(content: string): AnswerBlock[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const blocks: AnswerBlock[] = []
  let paragraph: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ kind: "paragraph", spans: parseInline(paragraph.join(" ").trim()) })
    paragraph = []
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ""

    const fence = FENCE_RE.exec(line)
    if (fence !== null) {
      flushParagraph()
      const language = (fence[1] ?? "").trim()
      const body: string[] = []
      i += 1
      while (i < lines.length && !FENCE_RE.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "")
        i += 1
      }
      blocks.push({ kind: "code", language: language === "" ? null : language, code: body.join("\n") })
      continue
    }

    // A table needs its delimiter row to be the very next line; without that
    // check any prose containing a pipe would be mistaken for a header.
    const next = lines[i + 1]
    if (line.includes("|") && next !== undefined && DELIMITER_RE.test(next) && next.includes("-")) {
      flushParagraph()
      const headers = splitTableRow(line)
      const declared = splitTableRow(next).map(alignOf)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && (lines[i] ?? "").includes("|")) {
        const cells = splitTableRow(lines[i] ?? "")
        // Pad or trim to the header width so the grid can never go ragged.
        while (cells.length < headers.length) cells.push("")
        rows.push(cells.slice(0, headers.length))
        i += 1
      }
      i -= 1
      const aligns = headers.map((_, column) => {
        const explicit = declared[column]
        if (explicit !== undefined && explicit !== "left") return explicit
        // Numbers read far better right-aligned, and the model rarely bothers
        // to declare alignment. Only do it when the whole column is numeric.
        const values = rows.map((row) => row[column] ?? "")
        const numeric = values.filter((value) => value.trim() !== "")
        if (numeric.length > 0 && numeric.every(looksNumeric)) return "right" as CellAlign
        return explicit ?? ("left" as CellAlign)
      })
      blocks.push({ kind: "table", headers, rows, aligns })
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading !== null) {
      flushParagraph()
      const hashes = heading[1] ?? "#"
      const level = Math.min(3, hashes.length) as 1 | 2 | 3
      blocks.push({ kind: "heading", level, spans: parseInline((heading[2] ?? "").trim()) })
      continue
    }

    const bullet = BULLET_RE.exec(line)
    const ordered = ORDERED_RE.exec(line)
    if (bullet !== null || ordered !== null) {
      flushParagraph()
      const isOrdered = ordered !== null && bullet === null
      const items: InlineSpan[][] = []
      while (i < lines.length) {
        const candidate = lines[i] ?? ""
        const asBullet = BULLET_RE.exec(candidate)
        const asOrdered = ORDERED_RE.exec(candidate)
        const matched = isOrdered ? asOrdered : asBullet
        if (matched === null) break
        items.push(parseInline((matched[1] ?? "").trim()))
        i += 1
      }
      i -= 1
      blocks.push({ kind: "list", ordered: isOrdered, items })
      continue
    }

    if (line.trim() === "") {
      flushParagraph()
      continue
    }
    paragraph.push(line.trim())
  }
  flushParagraph()
  return blocks
}

/* ----------------------------- tool datasets ----------------------------- */

export type ToolDatasetColumn = { key: string; label: string }

export type ToolDataset = {
  objectType: string | null
  mode: string | null
  /** `own` means the rows cover only the asker's records, not the workspace. */
  scope: string | null
  columns: ToolDatasetColumn[]
  rows: Record<string, unknown>[]
  rowCount: number | null
  truncated: boolean
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

/**
 * Recover the query tool's dataset from a stored `role: "tool"` message.
 *
 * Returns `null` for anything that is not a `{columns, rows}` result —
 * including an error payload and a result the service truncated, whose
 * trailing `…[truncated]` makes it invalid JSON. `null` simply means "no
 * table to show", and the caller falls back to the prose answer.
 */
export function parseToolDataset(content: string): ToolDataset | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const rawColumns = record["columns"]
  const rawRows = record["rows"]
  if (!Array.isArray(rawColumns) || !Array.isArray(rawRows)) return null

  const columns: ToolDatasetColumn[] = []
  for (const entry of rawColumns) {
    if (typeof entry !== "object" || entry === null) return null
    const column = entry as Record<string, unknown>
    const key = asString(column["key"])
    if (key === null) return null
    columns.push({ key, label: asString(column["label"]) ?? key })
  }
  if (columns.length === 0) return null

  const rows: Record<string, unknown>[] = []
  for (const entry of rawRows) {
    if (typeof entry !== "object" || entry === null) continue
    rows.push(entry as Record<string, unknown>)
  }

  const rowCount = record["rowCount"]
  return {
    objectType: asString(record["objectType"]),
    mode: asString(record["mode"]),
    scope: asString(record["scope"]),
    columns,
    rows,
    rowCount: typeof rowCount === "number" ? rowCount : null,
    truncated: record["truncated"] === true,
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/

/**
 * One dataset cell as display text. Values arrive as `unknown` from the
 * reports engine, so every branch is explicit and nothing is assumed.
 * An absent value renders as an em dash rather than "null" or a blank that
 * reads as an empty string the record actually holds.
 */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toLocaleString() : "—"
  }
  if (typeof value === "string") {
    if (ISO_DATE_RE.test(value)) {
      const date = new Date(value)
      if (!Number.isNaN(date.getTime())) {
        return value.length <= 10 ? date.toLocaleDateString() : date.toLocaleString()
      }
    }
    return value
  }
  return JSON.stringify(value) ?? "—"
}

/** Right-align a dataset column only when every value in it is a number. */
export function datasetColumnAlign(
  rows: readonly Record<string, unknown>[],
  key: string,
): CellAlign {
  const values = rows.map((row) => row[key]).filter((value) => value !== null && value !== undefined)
  if (values.length === 0) return "left"
  return values.every((value) => typeof value === "number") ? "right" : "left"
}
