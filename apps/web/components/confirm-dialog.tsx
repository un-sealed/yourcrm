"use client"

import { useState } from "react"
import { Button } from "@yourcrm/ui"

/**
 * Confirmation dialog primitive. Domain agents use this for destructive
 * actions instead of building one-off modals.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel = "Confirm",
  onConfirm,
  onCancel,
}: {
  title: string
  description?: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="alertdialog"
    >
      <div className="w-full max-w-sm rounded-lg border bg-background p-5 shadow-xl">
        <h2 className="text-base font-semibold">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Controlled wrapper: renders children trigger + dialog on `open`. */
export function useConfirm() {
  const [open, setOpen] = useState(false)
  return { open, setOpen }
}
