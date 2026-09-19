import * as React from "react"
import { cn } from "./utils"

export interface TabItem {
  value: string
  label: React.ReactNode
  content?: React.ReactNode
  disabled?: boolean
}

export interface TabsProps {
  value: string
  onValueChange: (value: string) => void
  items: TabItem[]
  ariaLabel?: string
  className?: string
}

/**
 * Controlled tabs with roving tabindex and arrow-key navigation. The active
 * tab's `content` renders in a `tabpanel` below the tab list.
 */
export const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(function Tabs(
  { value, onValueChange, items, ariaLabel = "Tabs", className },
  ref,
) {
  const tabRefs = React.useRef<Array<HTMLButtonElement | null>>([])

  const focusTab = (index: number): void => {
    const normalized = (index + items.length) % items.length
    const tab = tabRefs.current[normalized]
    tab?.focus()
    const item = items[normalized]
    if (item !== undefined && item.disabled !== true) {
      onValueChange(item.value)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const currentIndex = items.findIndex((item) => item.value === value)
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault()
      focusTab(currentIndex + 1)
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault()
      focusTab(currentIndex - 1)
    } else if (event.key === "Home") {
      event.preventDefault()
      focusTab(0)
    } else if (event.key === "End") {
      event.preventDefault()
      focusTab(items.length - 1)
    }
  }

  const active = items.find((item) => item.value === value) ?? null

  return (
    <div ref={ref} data-slot="tabs" className={cn("flex flex-col gap-3", className)}>
      <div role="tablist" aria-label={ariaLabel} onKeyDown={handleKeyDown} className="flex gap-1">
        {items.map((item, index) => {
          const selected = item.value === value
          return (
            <button
              key={item.value}
              ref={(node) => {
                tabRefs.current[index] = node
              }}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`tabpanel-${item.value}`}
              id={`tab-${item.value}`}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => onValueChange(item.value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:cursor-not-allowed disabled:opacity-50",
                selected
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          )
        })}
      </div>
      {active?.content !== undefined ? (
        <div
          role="tabpanel"
          id={`tabpanel-${active.value}`}
          aria-labelledby={`tab-${active.value}`}
          tabIndex={0}
          className="focus-visible:outline-none"
        >
          {active.content}
        </div>
      ) : null}
    </div>
  )
})
