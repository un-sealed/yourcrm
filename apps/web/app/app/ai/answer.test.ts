import { describe, expect, test } from "bun:test"
import {
  datasetColumnAlign,
  formatCellValue,
  looksNumeric,
  parseAnswerBlocks,
  parseInline,
  parseToolDataset,
  splitTableRow,
  type AnswerBlock,
} from "./answer"

function tableOf(blocks: AnswerBlock[]) {
  const table = blocks.find((block) => block.kind === "table")
  if (table === undefined || table.kind !== "table") throw new Error("no table block")
  return table
}

describe("ai/parseInline", () => {
  test("splits emphasis out of surrounding text", () => {
    expect(parseInline("a **b** c")).toEqual([
      { kind: "text", text: "a " },
      { kind: "bold", text: "b" },
      { kind: "text", text: " c" },
    ])
  })

  test("bold wins over italic, and code wins over both", () => {
    expect(parseInline("**b**")).toEqual([{ kind: "bold", text: "b" }])
    expect(parseInline("*i*")).toEqual([{ kind: "italic", text: "i" }])
    expect(parseInline("`**not bold**`")).toEqual([{ kind: "code", text: "**not bold**" }])
  })

  test("plain text passes through as a single span", () => {
    expect(parseInline("just words")).toEqual([{ kind: "text", text: "just words" }])
  })
})

describe("ai/splitTableRow", () => {
  test("drops the edge pipes and trims cells", () => {
    expect(splitTableRow("| Deal | Amount |")).toEqual(["Deal", "Amount"])
    expect(splitTableRow("Deal | Amount")).toEqual(["Deal", "Amount"])
  })

  test("an escaped pipe stays inside its cell", () => {
    // Splitting naively on "|" would tear this cell in two and shift every
    // column after it one to the left.
    expect(splitTableRow("| a \\| b | c |")).toEqual(["a | b", "c"])
  })
})

describe("ai/looksNumeric", () => {
  test("accepts the shapes a CRM actually prints", () => {
    for (const value of ["12", "-3", "1,200", "$1,200.50", "45%", "(250)"]) {
      expect(looksNumeric(value)).toBe(true)
    }
  })

  test("rejects prose and blanks", () => {
    for (const value of ["", "  ", "Acme", "2026-09-20x"]) {
      expect(looksNumeric(value)).toBe(false)
    }
  })
})

describe("ai/parseAnswerBlocks", () => {
  test("a GFM table becomes a table block, not lines of pipes", () => {
    // The whole point of this module: the page used to print this verbatim.
    const blocks = parseAnswerBlocks(
      ["Here are the deals:", "", "| Deal | Amount |", "| --- | --- |", "| Acme | 1200 |"].join("\n"),
    )
    const table = tableOf(blocks)
    expect(table.headers).toEqual(["Deal", "Amount"])
    expect(table.rows).toEqual([["Acme", "1200"]])
    expect(blocks[0]?.kind).toBe("paragraph")
  })

  test("a numeric column is right-aligned even when undeclared", () => {
    const table = tableOf(
      parseAnswerBlocks(["| Stage | Count |", "|---|---|", "| Won | 12 |", "| Lost | 3 |"].join("\n")),
    )
    expect(table.aligns).toEqual(["left", "right"])
  })

  test("an explicit alignment is honoured over the numeric guess", () => {
    const table = tableOf(
      parseAnswerBlocks(["| A | B |", "|:---:|:---|", "| 1 | 2 |"].join("\n")),
    )
    expect(table.aligns[0]).toBe("center")
  })

  test("ragged rows are padded to the header width", () => {
    const table = tableOf(
      parseAnswerBlocks(["| A | B | C |", "|---|---|---|", "| 1 |"].join("\n")),
    )
    expect(table.rows).toEqual([["1", "", ""]])
  })

  test("prose containing a pipe is not mistaken for a table", () => {
    // No delimiter row follows, so this is just a sentence.
    const blocks = parseAnswerBlocks("Filter by stage | status to narrow it down.")
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.kind).toBe("paragraph")
  })

  test("bullet and ordered lists group their items", () => {
    const bullets = parseAnswerBlocks("- one\n- two")
    expect(bullets).toHaveLength(1)
    expect(bullets[0]).toMatchObject({ kind: "list", ordered: false })
    const ordered = parseAnswerBlocks("1. one\n2. two")
    expect(ordered[0]).toMatchObject({ kind: "list", ordered: true })
  })

  test("fenced code keeps its body verbatim", () => {
    const blocks = parseAnswerBlocks("```sql\nSELECT 1\n```")
    expect(blocks[0]).toEqual({ kind: "code", language: "sql", code: "SELECT 1" })
  })

  test("headings cap at level 3", () => {
    const blocks = parseAnswerBlocks("##### deep")
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 3 })
  })

  test("unrecognised text survives as a paragraph, never dropped", () => {
    const blocks = parseAnswerBlocks("There are 4 open deals.")
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      spans: [{ kind: "text", text: "There are 4 open deals." }],
    })
  })

  test("empty content yields no blocks", () => {
    expect(parseAnswerBlocks("")).toEqual([])
    expect(parseAnswerBlocks("\n\n")).toEqual([])
  })
})

describe("ai/parseToolDataset", () => {
  const dataset = JSON.stringify({
    objectType: "deal",
    mode: "list",
    scope: "own",
    columns: [
      { key: "name", label: "Deal" },
      { key: "amount", label: "Amount" },
    ],
    rows: [{ name: "Acme", amount: 1200 }],
    rowCount: 1,
    truncated: false,
  })

  test("recovers the reports-engine dataset", () => {
    const parsed = parseToolDataset(dataset)
    expect(parsed?.columns).toEqual([
      { key: "name", label: "Deal" },
      { key: "amount", label: "Amount" },
    ])
    expect(parsed?.rows).toEqual([{ name: "Acme", amount: 1200 }])
    expect(parsed?.scope).toBe("own")
    expect(parsed?.rowCount).toBe(1)
  })

  test("a column without a label falls back to its key", () => {
    const parsed = parseToolDataset(
      JSON.stringify({ columns: [{ key: "amount" }], rows: [{ amount: 1 }] }),
    )
    expect(parsed?.columns[0]).toEqual({ key: "amount", label: "amount" })
  })

  test("returns null for payloads that are not datasets", () => {
    // An error result, a non-dataset object, and a scalar.
    expect(parseToolDataset(JSON.stringify({ error: "permission_denied" }))).toBe(null)
    expect(parseToolDataset(JSON.stringify({ objects: ["deal"] }))).toBe(null)
    expect(parseToolDataset(JSON.stringify(42))).toBe(null)
  })

  test("returns null rather than throwing on truncated or invalid JSON", () => {
    // The service caps tool results and appends "…[truncated]", which leaves
    // the stored string unparseable. That must degrade to prose, not crash.
    expect(parseToolDataset(`${dataset.slice(0, 40)}…[truncated]`)).toBe(null)
    expect(parseToolDataset("not json at all")).toBe(null)
  })

  test("an empty result set is still a dataset, so the view can say 'no rows'", () => {
    const parsed = parseToolDataset(
      JSON.stringify({ columns: [{ key: "name", label: "Deal" }], rows: [], rowCount: 0 }),
    )
    expect(parsed).not.toBe(null)
    expect(parsed?.rows).toEqual([])
  })
})

describe("ai/formatCellValue", () => {
  test("absent values read as an em dash, not 'null'", () => {
    expect(formatCellValue(null)).toBe("—")
    expect(formatCellValue(undefined)).toBe("—")
  })

  test("booleans and numbers are humanised", () => {
    expect(formatCellValue(true)).toBe("Yes")
    expect(formatCellValue(false)).toBe("No")
    expect(formatCellValue(1200)).toBe((1200).toLocaleString())
    expect(formatCellValue(Number.NaN)).toBe("—")
  })

  test("an ISO date is localised, other strings pass through", () => {
    expect(formatCellValue("2026-09-20")).toBe(new Date("2026-09-20").toLocaleDateString())
    expect(formatCellValue("Acme Corp")).toBe("Acme Corp")
    // A string that merely starts like a date must not be mangled.
    expect(formatCellValue("2026-09-20 rollout")).toBe("2026-09-20 rollout")
  })

  test("objects are stringified rather than rendered as [object Object]", () => {
    expect(formatCellValue({ a: 1 })).toBe('{"a":1}')
  })
})

describe("ai/datasetColumnAlign", () => {
  test("right-aligns a column only when every value is a number", () => {
    const rows = [
      { amount: 1, name: "a" },
      { amount: 2, name: "b" },
    ]
    expect(datasetColumnAlign(rows, "amount")).toBe("right")
    expect(datasetColumnAlign(rows, "name")).toBe("left")
  })

  test("nulls are ignored, an all-null column stays left", () => {
    expect(datasetColumnAlign([{ a: 1 }, { a: null }], "a")).toBe("right")
    expect(datasetColumnAlign([{ a: null }], "a")).toBe("left")
  })
})
