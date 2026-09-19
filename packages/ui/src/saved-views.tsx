import * as React from "react"
import { Button } from "./button"
import { TextField } from "./text-field"
import { cn } from "./utils"

export interface SavedView {
  id: string
  name: string
}

export interface SavedViewsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onSelect"> {
  views: SavedView[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: (name: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  className?: string
}

function readNamedInput(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name)
  if (typeof HTMLInputElement !== "undefined" && field instanceof HTMLInputElement) {
    return field.value
  }
  const maybe = field as { value?: unknown } | null
  return typeof maybe?.value === "string" ? maybe.value : ""
}

/**
 * Named view chips with create/rename/delete. Forms are uncontrolled so the
 * component stays hook-free; drafts live in the DOM until submitted.
 */
export const SavedViews = React.forwardRef<HTMLDivElement, SavedViewsProps>(function SavedViews(
  { views, activeId, onSelect, onCreate, onRename, onDelete, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="saved-views"
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      {...props}
    >
      {views.map((view) => {
        const active = view.id === activeId
        return (
          <span
            key={view.id}
            className={cn(
              "inline-flex items-center gap-0.5 rounded-full border transition-colors",
              active
                ? "border-primary bg-primary/10"
                : "border-border bg-background hover:bg-accent",
            )}
          >
            <button
              type="button"
              aria-pressed={active}
              aria-label={`Apply view ${view.name}`}
              onClick={() => onSelect(view.id)}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active ? "text-primary" : "text-foreground",
              )}
            >
              {view.name}
            </button>
            <details className="relative">
              <summary
                aria-label={`Rename view ${view.name}`}
                className="cursor-pointer list-none rounded-full px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
              >
                ✎
              </summary>
              <form
                className="absolute left-0 top-full z-50 mt-1 flex items-center gap-1 rounded-md border border-border bg-background p-1.5 shadow-md"
                onSubmit={(event) => {
                  event.preventDefault()
                  const next = readNamedInput(event.currentTarget, "view-name").trim()
                  if (next !== "") {
                    onRename(view.id, next)
                  }
                  const details = event.currentTarget.closest("details")
                  if (details !== null) {
                    details.removeAttribute("open")
                  }
                }}
              >
                <TextField
                  name="view-name"
                  defaultValue={view.name}
                  aria-label={`New name for ${view.name}`}
                  className="h-7 w-32 text-xs"
                />
                <Button type="submit" size="sm" className="h-7 px-2 text-xs">
                  Save
                </Button>
              </form>
            </details>
            <button
              type="button"
              aria-label={`Delete view ${view.name}`}
              onClick={() => onDelete(view.id)}
              className="rounded-full px-1 text-xs text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              ✕
            </button>
          </span>
        )
      })}
      <form
        aria-label="Create view"
        className="flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault()
          const name = readNamedInput(event.currentTarget, "new-view-name").trim()
          if (name !== "") {
            onCreate(name)
            event.currentTarget.reset()
          }
        }}
      >
        <TextField
          name="new-view-name"
          placeholder="Save current view…"
          aria-label="New view name"
          className="h-7 w-36 text-xs"
        />
        <Button type="submit" variant="outline" size="sm" className="h-7 px-2 text-xs">
          Save view
        </Button>
      </form>
    </div>
  )
})
