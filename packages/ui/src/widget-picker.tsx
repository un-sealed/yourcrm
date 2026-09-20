import * as React from "react"
import { Dialog } from "./dialog"
import { cn } from "./utils"

export interface WidgetPickerItem {
  id: string
  title: string
  description: string
  tag: string
  preview?: React.ReactNode
}

export interface WidgetPickerRowProps {
  widget: WidgetPickerItem
  onSelect: (id: string) => void
}

/** One picker row: preview thumbnail, title + description, `#Tag` pill, Select. */
export function WidgetPickerRow({ widget, onSelect }: WidgetPickerRowProps): React.ReactElement {
  return (
    <li
      data-slot="widget-picker-item"
      data-widget-id={widget.id}
      className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
    >
      <div
        aria-hidden="true"
        className="flex h-14 w-20 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-ctl)] bg-[var(--surface-2)]"
      >
        {widget.preview}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-[var(--text-primary)]">{widget.title}</p>
        <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{widget.description}</p>
        <span className="mt-1.5 inline-flex items-center rounded-[var(--radius-pill)] border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
          #{widget.tag}
        </span>
      </div>
      <button
        type="button"
        aria-label={`Select ${widget.title}`}
        onClick={() => onSelect(widget.id)}
        className="shrink-0 rounded-[var(--radius-pill)] bg-[var(--brand)] px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--brand-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-strong)]"
      >
        Select
      </button>
    </li>
  )
}

export interface WidgetPickerListProps {
  widgets: WidgetPickerItem[]
  onSelect: (id: string) => void
  className?: string
}

/** Scrollable widget list with an empty state. Hook-free so it stays testable. */
export function WidgetPickerList({
  widgets,
  onSelect,
  className,
}: WidgetPickerListProps): React.ReactElement {
  if (widgets.length === 0) {
    return (
      <p className={cn("py-6 text-center text-sm text-[var(--text-muted)]", className)}>
        No widgets available.
      </p>
    )
  }
  return (
    <ul
      data-slot="widget-picker-list"
      className={cn("max-h-[60vh] divide-y divide-[var(--border)] overflow-y-auto", className)}
    >
      {widgets.map((widget) => (
        <WidgetPickerRow key={widget.id} widget={widget} onSelect={onSelect} />
      ))}
    </ul>
  )
}

export interface WidgetPickerProps {
  open: boolean
  onClose: () => void
  widgets: WidgetPickerItem[]
  onSelect: (id: string) => void
  className?: string
}

/**
 * Widget picker modal. Overlay, Escape-to-close, focus trap and focus return
 * all come from the shared `Dialog` primitive — nothing hand-rolled here.
 */
export function WidgetPicker({
  open,
  onClose,
  widgets,
  onSelect,
  className,
}: WidgetPickerProps): React.ReactElement | null {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
      title={
        <span className="flex items-center justify-between gap-3">
          <span>Add widget</span>
          <button
            type="button"
            aria-label="Close widget picker"
            onClick={onClose}
            className="rounded-[var(--radius-ctl)] p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-strong)]"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </span>
      }
      className={cn(
        "max-w-[520px] rounded-[var(--radius-card)] bg-[var(--surface-1)] shadow-[var(--shadow-pop)]",
        className,
      )}
    >
      <div data-slot="widget-picker">
        <WidgetPickerList widgets={widgets} onSelect={onSelect} />
      </div>
    </Dialog>
  )
}
