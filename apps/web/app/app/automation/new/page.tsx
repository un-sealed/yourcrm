"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button, ErrorState, buttonVariants } from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"
import { emptyWorkflowAction, type Workflow, type WorkflowCatalogue } from "../types"
import {
  isWorkflowDraftValid,
  toWorkflowPayload,
  WorkflowEditor,
  type WorkflowDraft,
} from "../workflow-editor"

const BLANK: WorkflowDraft = {
  name: "",
  description: "",
  triggerEvent: "",
  conditions: null,
  actions: [emptyWorkflowAction("create_task")],
}

/** Create an automation. It is always saved disabled — enable it after review. */
export default function NewAutomationPage() {
  const router = useRouter()
  const [draft, setDraft] = useState<WorkflowDraft>(BLANK)
  const [catalogue, setCatalogue] = useState<WorkflowCatalogue | null>(null)
  const [catalogueError, setCatalogueError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    apiFetch<WorkflowCatalogue>("/api/v1/automation/catalogue")
      .then(setCatalogue)
      .catch((err: unknown) =>
        setCatalogueError(
          err instanceof ApiError ? err.message : "Could not load the trigger catalogue.",
        ),
      )
  }, [])

  // Guard against losing a half-written automation on navigation.
  useEffect(() => {
    const dirty = draft.name !== "" || draft.triggerEvent !== ""
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [draft])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const created = await apiFetch<Workflow>("/api/v1/automation", {
        method: "POST",
        body: toWorkflowPayload(draft),
      })
      router.push(`/app/automation/${created.id}`)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === "FORBIDDEN"
            ? "You do not have permission to create automations."
            : err.message
          : "Could not save that automation.",
      )
      setSaving(false)
    }
  }

  if (catalogueError !== null) {
    return <ErrorState message={catalogueError} onRetry={() => window.location.reload()} />
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">New automation</h1>
          <p className="text-sm text-muted-foreground">
            Saved disabled — review it, then enable it when you are happy.
          </p>
        </div>
        <Link href="/app/automation" className={buttonVariants({ variant: "outline" })}>
          Cancel
        </Link>
      </header>

      <WorkflowEditor draft={draft} catalogue={catalogue} disabled={saving} onChange={setDraft} />

      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button disabled={saving || !isWorkflowDraftValid(draft)} onClick={() => void save()}>
          {saving ? "Saving…" : "Save automation"}
        </Button>
        <Link href="/app/automation" className={buttonVariants({ variant: "ghost" })}>
          Cancel
        </Link>
      </div>
    </div>
  )
}
