import * as React from "react"
import { Button } from "./button"
import { cn } from "./utils"

export interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
  className?: string
}

let dialogCounter = 0

function nextDialogId(): string {
  dialogCounter += 1
  return `dialog-${dialogCounter}`
}

function focusableIn(root: HTMLElement): HTMLElement[] {
  const selectors = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    '[tabindex]:not([tabindex="-1"])',
  ]
  return Array.from(root.querySelectorAll<HTMLElement>(selectors.join(","))).filter(
    (element) => element.offsetParent !== null || element === document.activeElement,
  )
}

/**
 * Modal dialog without a Radix dependency. Traps focus, closes on Escape and
 * on overlay click. Fully controlled via `open` / `onOpenChange`.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: DialogProps): React.ReactElement | null {
  const titleId = React.useMemo(() => nextDialogId(), [])
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const previousFocus = React.useRef<Element | null>(null)

  React.useEffect(() => {
    if (!open) {
      return
    }
    previousFocus.current = document.activeElement
    panelRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation()
        onOpenChange(false)
      }
    }
    document.addEventListener("keydown", handleKeyDown, true)
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true)
      if (previousFocus.current instanceof HTMLElement) {
        previousFocus.current.focus()
      }
    }
  }, [open, onOpenChange])

  if (!open) {
    return null
  }

  const trapTab = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Tab" || panelRef.current === null) {
      return
    }
    const focusable = focusableIn(panelRef.current)
    if (focusable.length === 0) {
      return
    }
    const first = focusable[0] as HTMLElement
    const last = focusable[focusable.length - 1] as HTMLElement
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      data-slot="dialog-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onOpenChange(false)
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title !== undefined ? `${titleId}-title` : undefined}
        aria-describedby={description !== undefined ? `${titleId}-description` : undefined}
        tabIndex={-1}
        data-slot="dialog"
        onKeyDown={trapTab}
        className={cn(
          "w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-pop",
          "focus-visible:outline-none",
          className,
        )}
      >
        {title !== undefined ? (
          <h2 id={`${titleId}-title`} className="text-base font-semibold text-foreground">
            {title}
          </h2>
        ) : null}
        {description !== undefined ? (
          <p id={`${titleId}-description`} className="mt-1 text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
        <div className={cn(title !== undefined || description !== undefined ? "mt-4" : undefined)}>
          {children}
        </div>
      </div>
    </div>
  )
}

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  loading?: boolean
  danger?: boolean
  className?: string
}

/** Confirmation dialog with confirm/cancel actions and a pending state. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  loading = false,
  danger = false,
  className,
}: ConfirmDialogProps): React.ReactElement | null {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <div className={cn("flex justify-end gap-2", className)}>
        <Button
          type="button"
          variant="outline"
          disabled={loading}
          onClick={() => onOpenChange(false)}
        >
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant={danger ? "destructive" : "default"}
          disabled={loading}
          onClick={onConfirm}
        >
          {loading ? "Working…" : confirmLabel}
        </Button>
      </div>
    </Dialog>
  )
}
