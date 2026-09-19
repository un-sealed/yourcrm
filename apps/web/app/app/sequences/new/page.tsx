"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button, buttonVariants, Checkbox, Field, TextArea, TextField } from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"
import type { Sequence } from "../types"

/**
 * Create a sequence. It is always saved as a DRAFT: steps come next, and
 * activating it is a separate, separately-permissioned act (`send_external`)
 * on the detail page — nobody should be able to start emailing prospects
 * with the same click that names the sequence.
 */
export default function NewSequencePage() {
  const router = useRouter()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [exitOnReply, setExitOnReply] = useState(true)
  const [exitOnBounce, setExitOnBounce] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Guard against losing a half-written sequence on navigation.
  useEffect(() => {
    if (name === "" && description === "") return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [name, description])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const created = await apiFetch<Sequence>("/api/v1/sequences", {
        method: "POST",
        body: {
          name: name.trim(),
          description: description.trim() === "" ? null : description.trim(),
          exitOnReply,
          exitOnBounce,
        },
      })
      router.push(`/app/sequences/${created.id}`)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === "FORBIDDEN"
            ? "You do not have permission to create sequences."
            : err.message
          : "Could not save that sequence.",
      )
      setSaving(false)
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">New sequence</h1>
          <p className="text-sm text-muted-foreground">
            Saved as a draft — add the steps, then activate it when you are happy.
          </p>
        </div>
        <Link href="/app/sequences" className={buttonVariants({ variant: "outline" })}>
          Cancel
        </Link>
      </header>

      <Field label="Name" htmlFor="sequence-name" required>
        <TextField
          id="sequence-name"
          value={name}
          disabled={saving}
          invalid={name.trim() === ""}
          placeholder="Outbound — Q2 founders"
          onChange={(e) => setName(e.currentTarget.value)}
        />
      </Field>

      <Field
        label="Description"
        htmlFor="sequence-description"
        hint="Who this is for, and what it is trying to achieve."
      >
        <TextArea
          id="sequence-description"
          value={description}
          rows={3}
          disabled={saving}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
      </Field>

      <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">Stop conditions</legend>
        <p className="text-sm text-muted-foreground">
          Unsubscribes and manual removals always stop a sequence. These two are the ones you can
          turn off — and you almost never should.
        </p>
        <label htmlFor="exit-on-reply" className="flex items-center gap-2 text-sm">
          <Checkbox
            id="exit-on-reply"
            checked={exitOnReply}
            disabled={saving}
            onChange={(e) => setExitOnReply(e.currentTarget.checked)}
          />
          Stop when the person replies
        </label>
        <label htmlFor="exit-on-bounce" className="flex items-center gap-2 text-sm">
          <Checkbox
            id="exit-on-bounce"
            checked={exitOnBounce}
            disabled={saving}
            onChange={(e) => setExitOnBounce(e.currentTarget.checked)}
          />
          Stop when their mailbox bounces
        </label>
      </fieldset>

      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button disabled={saving || name.trim() === ""} onClick={() => void save()}>
          {saving ? "Saving…" : "Save sequence"}
        </Button>
        <Link href="/app/sequences" className={buttonVariants({ variant: "ghost" })}>
          Cancel
        </Link>
      </div>
    </div>
  )
}
