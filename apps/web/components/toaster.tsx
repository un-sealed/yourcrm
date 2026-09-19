"use client"

import { useUiStore } from "@/lib/store"

/** Global toast system (foundation). Domain agents call pushToast on mutation. */
export function Toaster() {
  const { toasts, dismissToast } = useUiStore()
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="rounded-lg border bg-card p-3 shadow-lg">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-medium">{t.title}</p>
              {t.description && <p className="text-xs text-muted-foreground">{t.description}</p>}
            </div>
            <button
              onClick={() => dismissToast(t.id)}
              className="text-muted-foreground"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
