"use client"

import { useState } from "react"
import {
  datasetColumnAlign,
  formatCellValue,
  parseAnswerBlocks,
  type AnswerBlock,
  type CellAlign,
  type InlineSpan,
  type ToolDataset,
} from "./answer"

/**
 * Renders an assistant answer (spec 34-ai-assistant §3).
 *
 * The page previously dropped `message.content` into a `whitespace-pre-wrap`
 * div, so a Markdown table showed up as a stack of pipe characters and a
 * list as a column of hyphens. These components render the block tree from
 * `answer.ts` as real elements.
 *
 * Nothing here ever builds HTML from model output — every branch emits a
 * fixed React element with the model's text as a child, so there is no
 * injection surface and no sanitiser to maintain.
 */

const ALIGN_CLASS: Record<CellAlign, string> = {
  left: "text-left",
  right: "text-right tabular-nums",
  center: "text-center",
}

function Spans({ spans }: { spans: InlineSpan[] }) {
  return (
    <>
      {spans.map((span, index) => {
        const key = `${span.kind}-${String(index)}`
        if (span.kind === "bold") {
          return (
            <strong key={key} className="font-semibold text-ink-primary">
              {span.text}
            </strong>
          )
        }
        if (span.kind === "italic") {
          return (
            <em key={key} className="italic">
              {span.text}
            </em>
          )
        }
        if (span.kind === "code") {
          return (
            <code
              key={key}
              className="rounded-[4px] bg-surface-2 px-1 py-0.5 font-mono text-[0.85em] text-ink-primary"
            >
              {span.text}
            </code>
          )
        }
        return <span key={key}>{span.text}</span>
      })}
    </>
  )
}

/**
 * A Markdown table from the answer text. Scrolls horizontally on its own
 * rather than widening the chat column — a 7-column answer must not push the
 * composer off screen.
 */
function AnswerTable({ block }: { block: Extract<AnswerBlock, { kind: "table" }> }) {
  return (
    <div className="-mx-1 overflow-x-auto">
      {/* `w-auto`, not `w-full`: a two-column answer stretched across the
          card put a thousand pixels between "Proposal" and "20". The table
          hugs its content and the wrapper scrolls when it genuinely is wide. */}
      <table className="w-auto min-w-[16rem] max-w-full border-collapse text-sm">
        <thead>
          <tr>
            {block.headers.map((header, index) => (
              <th
                key={`${header}-${String(index)}`}
                scope="col"
                className={`border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-muted ${
                  ALIGN_CLASS[block.aligns[index] ?? "left"]
                }`}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={`row-${String(rowIndex)}`} className="border-b border-border last:border-0">
              {row.map((cell, cellIndex) => (
                <td
                  key={`cell-${String(cellIndex)}`}
                  className={`px-3 py-2 align-top text-ink-primary ${
                    ALIGN_CLASS[block.aligns[cellIndex] ?? "left"]
                  }`}
                >
                  {cell === "" ? <span className="text-ink-muted">—</span> : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function AnswerBody({ content }: { content: string }) {
  const blocks = parseAnswerBlocks(content)
  // A parse that finds nothing still has to show the answer.
  if (blocks.length === 0) {
    return <p className="whitespace-pre-wrap text-sm text-ink-primary">{content}</p>
  }
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed text-ink-primary">
      {blocks.map((block, index) => {
        const key = `${block.kind}-${String(index)}`
        if (block.kind === "table") return <AnswerTable key={key} block={block} />
        if (block.kind === "code") {
          return (
            <pre
              key={key}
              className="overflow-x-auto rounded-ctl border border-border bg-surface-2 p-3 font-mono text-xs text-ink-primary"
            >
              <code>{block.code}</code>
            </pre>
          )
        }
        if (block.kind === "heading") {
          const size =
            block.level === 1 ? "text-base" : block.level === 2 ? "text-sm" : "text-[13px]"
          return (
            <p key={key} className={`font-semibold text-ink-primary ${size}`}>
              <Spans spans={block.spans} />
            </p>
          )
        }
        if (block.kind === "list") {
          const ListTag = block.ordered ? "ol" : "ul"
          return (
            <ListTag
              key={key}
              className={`flex flex-col gap-1 pl-5 ${
                block.ordered ? "list-decimal" : "list-disc"
              } marker:text-ink-muted`}
            >
              {block.items.map((item, itemIndex) => (
                <li key={`item-${String(itemIndex)}`}>
                  <Spans spans={item} />
                </li>
              ))}
            </ListTag>
          )
        }
        // Prose is capped at a readable measure; tables and code above are
        // deliberately free to use the card's full width.
        return (
          <p key={key} className="max-w-[68ch]">
            <Spans spans={block.spans} />
          </p>
        )
      })}
    </div>
  )
}

/**
 * The rows the assistant actually read, straight from the reports engine.
 *
 * This is strictly better evidence than the model's prose: it is the typed
 * dataset the tool returned, so it cannot drift from what was asked. Collapsed
 * by default — the prose is the answer, and this is the receipt.
 *
 * `scope: "own"` is surfaced rather than hidden, because a figure covering
 * only the asker's records is a materially different claim from one covering
 * the workspace.
 */
export function ToolDataPanel({ dataset, label }: { dataset: ToolDataset; label: string }) {
  const [open, setOpen] = useState(false)
  const shown = dataset.rows.length
  const total = dataset.rowCount ?? shown
  const aligns = dataset.columns.map((column) => datasetColumnAlign(dataset.rows, column.key))

  return (
    <div className="overflow-hidden rounded-ctl border border-border bg-surface-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink-secondary transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={`h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform ${
            open ? "rotate-90" : ""
          }`}
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        <span className="font-medium text-ink-primary">{label}</span>
        <span className="text-ink-muted">
          {total === 0 ? "no rows" : `${String(total)} ${total === 1 ? "row" : "rows"}`}
        </span>
        {dataset.scope === "own" ? (
          <span className="rounded-pill bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-secondary">
            your records only
          </span>
        ) : null}
        {dataset.truncated ? (
          <span className="rounded-pill bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-secondary">
            truncated
          </span>
        ) : null}
      </button>

      {open ? (
        dataset.rows.length === 0 ? (
          <p className="border-t border-border px-3 py-4 text-center text-xs text-ink-muted">
            The query returned no rows.
          </p>
        ) : (
          <div className="max-h-80 overflow-auto border-t border-border">
            {/* Same reason as the answer table: a two-column dataset stretched
                to the panel width reads as two lists, not a table. */}
            <table className="w-auto min-w-[20rem] max-w-full border-collapse text-sm">
              <thead className="sticky top-0 bg-surface-1">
                <tr>
                  {dataset.columns.map((column, index) => (
                    <th
                      key={column.key}
                      scope="col"
                      className={`whitespace-nowrap border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-muted ${
                        ALIGN_CLASS[aligns[index] ?? "left"]
                      }`}
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dataset.rows.map((row, rowIndex) => (
                  <tr
                    key={`row-${String(rowIndex)}`}
                    className="border-b border-border last:border-0"
                  >
                    {dataset.columns.map((column, index) => (
                      <td
                        key={column.key}
                        className={`px-3 py-2 align-top text-ink-primary ${
                          ALIGN_CLASS[aligns[index] ?? "left"]
                        }`}
                      >
                        {formatCellValue(row[column.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </div>
  )
}
