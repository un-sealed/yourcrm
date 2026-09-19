import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "./utils"

export type ToastTone = "default" | "success" | "error" | "info" | "warning"

export interface ToastData {
  id: string
  title: string
  description?: string
  tone?: ToastTone
  /** Auto-dismiss after `duration` ms. Omit (or pass null) to persist. */
  duration?: number | null
}

export type NewToast = Omit<ToastData, "id"> & { id?: string }

const toastVariants = cva(
  "rounded-xl border border-border bg-card px-4 py-3 text-foreground shadow-pop",
  {
    variants: {
      tone: {
        default: "",
        success: "border-l-4 border-l-emerald-500",
        error: "border-l-4 border-l-destructive",
        info: "border-l-4 border-l-sky-500",
        warning: "border-l-4 border-l-amber-500",
      },
    },
    defaultVariants: { tone: "default" },
  },
)

type ToastListener = () => void

function createToastStore(): {
  subscribe: (listener: ToastListener) => () => void
  getSnapshot: () => ToastData[]
  push: (toast: NewToast) => string
  dismiss: (id: string) => void
  clear: () => void
} {
  let toasts: ToastData[] = []
  const listeners = new Set<ToastListener>()
  let counter = 0
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const notify = (): void => {
    for (const listener of listeners) {
      listener()
    }
  }

  const dismiss = (id: string): void => {
    const timer = timers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(id)
    }
    if (toasts.some((toast) => toast.id === id)) {
      toasts = toasts.filter((toast) => toast.id !== id)
      notify()
    }
  }

  return {
    subscribe: (listener: ToastListener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => toasts,
    push: (toast: NewToast) => {
      counter += 1
      const id = toast.id ?? `toast-${counter}`
      dismiss(id)
      const data: ToastData = {
        id,
        title: toast.title,
        description: toast.description,
        tone: toast.tone ?? "default",
        duration: toast.duration ?? null,
      }
      toasts = [...toasts, data]
      if (typeof data.duration === "number" && Number.isFinite(data.duration)) {
        timers.set(
          id,
          setTimeout(() => dismiss(id), data.duration),
        )
      }
      notify()
      return id
    },
    dismiss,
    clear: () => {
      for (const timer of timers.values()) {
        clearTimeout(timer)
      }
      timers.clear()
      if (toasts.length > 0) {
        toasts = []
        notify()
      }
    },
  }
}

/**
 * Framework-free toast store (no Zustand dependency in this workspace).
 * `Toaster` renders `toastStore` by default; pass `toasts` for a controlled
 * or test render.
 */
export const toastStore = createToastStore()

/** Push a toast. Returns the toast id. */
export function toast(input: NewToast): string {
  return toastStore.push(input)
}

export interface ToasterProps extends VariantProps<typeof toastVariants> {
  toasts?: ToastData[]
  onDismiss?: (id: string) => void
  className?: string
}

/** Bottom-right stacked toast region. Hook-free; pair with `toastStore`. */
export const Toaster = React.forwardRef<HTMLDivElement, ToasterProps>(function Toaster(
  { toasts = toastStore.getSnapshot(), onDismiss = (id) => toastStore.dismiss(id), className },
  ref,
) {
  if (toasts.length === 0) {
    return null
  }
  return (
    <div
      ref={ref}
      data-slot="toaster"
      role="status"
      aria-live="polite"
      className={cn("fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2", className)}
    >
      {toasts.map((item) => (
        <div
          key={item.id}
          data-slot="toast"
          data-tone={item.tone ?? "default"}
          className={toastVariants({ tone: item.tone ?? "default" })}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col gap-0.5">
              <p className="text-sm font-medium">{item.title}</p>
              {item.description !== undefined ? (
                <p className="text-xs text-muted-foreground">{item.description}</p>
              ) : null}
            </div>
            <button
              type="button"
              aria-label={`Dismiss ${item.title}`}
              onClick={() => onDismiss(item.id)}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  )
})

export interface StoreToasterProps {
  className?: string
}

/** Live `Toaster` bound to `toastStore` (subscribes, re-renders on change). */
export function StoreToaster({ className }: StoreToasterProps): React.ReactElement {
  const toasts = React.useSyncExternalStore(
    toastStore.subscribe,
    toastStore.getSnapshot,
    toastStore.getSnapshot,
  )
  return <Toaster toasts={toasts} className={className} />
}
