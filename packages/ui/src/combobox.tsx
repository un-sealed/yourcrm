import * as React from "react"
import { cn } from "./utils"

export interface ComboboxOption {
  value: string
  label: string
  disabled?: boolean
}

export interface ComboboxProps {
  value: string | null
  onValueChange: (value: string | null) => void
  options: ComboboxOption[]
  open?: boolean
  onOpenChange?: (open: boolean) => void
  search?: string
  onSearchChange?: (search: string) => void
  placeholder?: string
  emptyLabel?: string
  label?: string
  inputId?: string
  className?: string
}

/** Case-insensitive substring filter shared by every combobox instance. */
export function filterComboboxOptions(options: ComboboxOption[], search: string): ComboboxOption[] {
  const query = search.trim().toLowerCase()
  if (query === "") {
    return options
  }
  return options.filter((option) => option.label.toLowerCase().includes(query))
}

let comboboxCounter = 0

function nextComboboxId(): string {
  comboboxCounter += 1
  return `combobox-${comboboxCounter}`
}

function useControlledState<T>(
  controlled: T | undefined,
  defaultValue: T,
  onChange?: (value: T) => void,
): [T, (value: T) => void] {
  const [internal, setInternal] = React.useState<T>(defaultValue)
  const value = controlled === undefined ? internal : controlled
  const set = React.useCallback(
    (next: T) => {
      if (controlled === undefined) {
        setInternal(next)
      }
      onChange?.(next)
    },
    [controlled, onChange],
  )
  return [value, set]
}

/**
 * Filterable option picker. Fully controlled when `open`/`search` are
 * provided; otherwise manages its own open/search state and only `value` +
 * `onValueChange` are required.
 */
export function Combobox({
  value,
  onValueChange,
  options,
  open: openProp,
  onOpenChange,
  search: searchProp,
  onSearchChange,
  placeholder = "Search…",
  emptyLabel = "No results found.",
  label,
  inputId,
  className,
}: ComboboxProps): React.ReactElement {
  const [open, setOpen] = useControlledState(openProp, false, onOpenChange)
  const [search, setSearch] = useControlledState(searchProp, "", onSearchChange)
  const [highlighted, setHighlighted] = React.useState(0)
  const listId = React.useMemo(() => nextComboboxId(), [])
  const filtered = React.useMemo(() => filterComboboxOptions(options, search), [options, search])
  const selected = options.find((option) => option.value === value) ?? null

  const choose = (option: ComboboxOption): void => {
    if (option.disabled === true) {
      return
    }
    onValueChange(option.value)
    setSearch("")
    setOpen(false)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown" || (event.key === "ArrowUp" && open)) {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      const enabled = filtered.filter((option) => option.disabled !== true)
      if (enabled.length === 0) {
        return
      }
      const delta = event.key === "ArrowDown" ? 1 : -1
      setHighlighted((current) => (current + delta + enabled.length) % enabled.length)
    } else if (event.key === "Enter") {
      const enabled = filtered.filter((option) => option.disabled !== true)
      const current = enabled[highlighted]
      if (open && current !== undefined) {
        event.preventDefault()
        choose(current)
      }
    } else if (event.key === "Escape") {
      if (open) {
        event.preventDefault()
        setOpen(false)
      } else {
        setSearch("")
      }
    }
  }

  const highlightedOption = filtered.filter((option) => option.disabled !== true)[highlighted]

  return (
    <div data-slot="combobox" className={cn("relative", className)}>
      {label !== undefined ? (
        <label htmlFor={inputId} className="sr-only">
          {label}
        </label>
      ) : null}
      <input
        id={inputId}
        role="combobox"
        type="text"
        autoComplete="off"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={
          open && highlightedOption !== undefined
            ? `${listId}-${highlightedOption.value}`
            : undefined
        }
        placeholder={selected?.label ?? placeholder}
        value={search}
        onChange={(event) => {
          setSearch(event.currentTarget.value)
          setHighlighted(0)
          if (!open) {
            setOpen(true)
          }
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        className={cn(
          "h-9 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground shadow-xs",
          "placeholder:text-muted-foreground",
          "focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        )}
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={label ?? "Options"}
          className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-xl border border-border bg-popover p-1 shadow-pop"
        >
          {filtered.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">{emptyLabel}</li>
          ) : (
            filtered.map((option, index) => {
              const enabledIndex = filtered
                .filter((candidate) => candidate.disabled !== true)
                .findIndex((candidate) => candidate.value === option.value)
              const active = enabledIndex === highlighted
              return (
                <li
                  key={option.value}
                  id={`${listId}-${option.value}`}
                  role="option"
                  aria-selected={option.value === value}
                  aria-disabled={option.disabled === true || undefined}
                  data-index={index}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(option)}
                  onMouseEnter={() => {
                    if (enabledIndex >= 0) {
                      setHighlighted(enabledIndex)
                    }
                  }}
                  className={cn(
                    "cursor-pointer rounded-md px-2 py-1.5 text-sm text-foreground transition-colors",
                    active && "bg-accent",
                    option.disabled === true && "cursor-not-allowed opacity-50",
                  )}
                >
                  {option.label}
                </li>
              )
            })
          )}
        </ul>
      ) : null}
    </div>
  )
}
