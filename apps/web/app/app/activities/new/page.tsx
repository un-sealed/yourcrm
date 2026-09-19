"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button, Field, Select, TextArea, TextField, toast } from "@yourcrm/ui"
import { useUnsavedGuard } from "@/components/use-unsaved-guard"
import { ApiError, apiFetch } from "@/lib/api-client"
import type { Activity } from "../_components/types"

const TYPE_OPTIONS = [
  { value: "note", label: "Note" },
  { value: "call", label: "Call" },
  { value: "meeting", label: "Meeting" },
  { value: "email", label: "Email" },
]

/** Create-activity form: required fields first, advanced fields collapsible. */
export default function NewActivityPage() {
  const router = useRouter()
  const [title, setTitle] = useState("")
  const [type, setType] = useState("note")
  const [subjectType, setSubjectType] = useState("")
  const [subjectId, setSubjectId] = useState("")
  const [body, setBody] = useState("")
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const dirty = title !== "" || body !== "" || subjectId !== ""
  useUnsavedGuard(dirty && !saving)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (title.trim() === "") {
      setFieldError("Title is required.")
      return
    }
    setFieldError(null)
    setSaving(true)
    try {
      const activity = await apiFetch<Activity>("/api/v1/activities", {
        method: "POST",
        body: {
          title: title.trim(),
          type,
          ...(subjectType === "" ? {} : { subjectType }),
          ...(subjectId.trim() === "" ? {} : { subjectId: subjectId.trim() }),
          ...(body.trim() === "" ? {} : { body: body.trim() }),
        },
      })
      toast({ title: "Activity created", description: `${title.trim()} was added.` })
      router.push(`/app/activities/${activity.id}`)
    } catch (err) {
      setFieldError(err instanceof ApiError ? err.message : "Could not create the activity.")
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">New activity</h1>
        <Link href="/app/activities" className="text-sm text-muted-foreground hover:underline">
          Back to activities
        </Link>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Title" htmlFor="title" required error={fieldError}>
          <TextField
            id="title"
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            placeholder="Call with Ada"
            required
            invalid={fieldError !== null && title.trim() === ""}
          />
        </Field>
        <Field label="Type" htmlFor="type">
          <Select
            id="type"
            value={type}
            onChange={(e) => setType(e.currentTarget.value)}
            options={TYPE_OPTIONS}
          />
        </Field>
        <Field label="Notes" htmlFor="body">
          <TextArea
            id="body"
            value={body}
            onChange={(e) => setBody(e.currentTarget.value)}
            placeholder="What happened, what is next…"
          />
        </Field>
        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
          <div className="mt-3 flex flex-col gap-4">
            <Field label="Linked record type" htmlFor="subject-type">
              <Select
                id="subject-type"
                value={subjectType}
                onChange={(e) => setSubjectType(e.currentTarget.value)}
                options={[
                  { value: "", label: "None" },
                  { value: "person", label: "Person" },
                  { value: "company", label: "Company" },
                  { value: "deal", label: "Deal" },
                  { value: "lead", label: "Lead" },
                ]}
              />
            </Field>
            <Field label="Linked record ID" htmlFor="subject-id">
              <TextField
                id="subject-id"
                value={subjectId}
                onChange={(e) => setSubjectId(e.currentTarget.value)}
                placeholder="Record id to attach this activity to"
              />
            </Field>
          </div>
        </details>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => router.push("/app/activities")}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Create activity"}
          </Button>
        </div>
      </form>
    </div>
  )
}
