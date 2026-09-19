"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Button,
  Combobox,
  Field,
  Select,
  TextArea,
  TextField,
  toast,
  type ComboboxOption,
} from "@yourcrm/ui"
import { useUnsavedGuard } from "@/components/use-unsaved-guard"
import { ApiError, apiFetchRaw } from "@/lib/api-client"
import {
  SUPPORT_TICKET_CHANNEL_OPTIONS,
  SUPPORT_TICKET_PRIORITY_OPTIONS,
  type SupportTicket,
} from "../types"

/** Minimal shape this page needs from `GET /api/v1/people` — no coupling to the people module's own types. */
type RequesterOption = { id: string; firstName: string; lastName: string | null }

function requesterLabel(person: RequesterOption): string {
  return [person.firstName, person.lastName]
    .filter((part) => part !== null && part !== "")
    .join(" ")
}

/** Create-ticket form: required fields first, advanced fields collapsible. */
export default function NewTicketPage() {
  const router = useRouter()
  const [subject, setSubject] = useState("")
  const [description, setDescription] = useState("")
  const [priority, setPriority] = useState<string>("normal")
  const [channel, setChannel] = useState<string>("manual")
  const [requesterId, setRequesterId] = useState<string | null>(null)
  const [requesterSearch, setRequesterSearch] = useState("")
  const [requesterOptions, setRequesterOptions] = useState<ComboboxOption[]>([])
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const dirty = subject !== "" || description !== "" || requesterId !== null
  useUnsavedGuard(dirty && !saving)

  useEffect(() => {
    let cancelled = false
    const qs = new URLSearchParams({ limit: "10" })
    if (requesterSearch.trim() !== "") qs.set("query", requesterSearch.trim())
    void apiFetchRaw<{ data: RequesterOption[] }>(`/api/v1/people?${qs.toString()}`)
      .then((res) => {
        if (cancelled) return
        setRequesterOptions(res.data.map((p) => ({ value: p.id, label: requesterLabel(p) })))
      })
      .catch(() => {
        if (!cancelled) setRequesterOptions([])
      })
    return () => {
      cancelled = true
    }
  }, [requesterSearch])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (subject.trim() === "") {
      setFieldError("Subject is required.")
      return
    }
    if (requesterId === null) {
      setFieldError("A requester is required.")
      return
    }
    setFieldError(null)
    setSaving(true)
    try {
      const ticket = await apiFetchRaw<{ data: SupportTicket }>("/api/v1/tickets", {
        method: "POST",
        body: {
          subject: subject.trim(),
          requesterId,
          priority,
          channel,
          ...(description.trim() === "" ? {} : { description: description.trim() }),
        },
      })
      toast({ title: "Ticket created", description: subject.trim() })
      router.push(`/app/tickets/${ticket.data.id}`)
    } catch (err) {
      setFieldError(err instanceof ApiError ? err.message : "Could not create the ticket.")
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">New ticket</h1>
        <Link href="/app/tickets" className="text-sm text-muted-foreground hover:underline">
          Back to tickets
        </Link>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Subject" htmlFor="ticket-subject" required error={fieldError}>
          <TextField
            id="ticket-subject"
            value={subject}
            onChange={(e) => setSubject(e.currentTarget.value)}
            placeholder="Cannot log in"
            required
            invalid={fieldError !== null && subject.trim() === ""}
          />
        </Field>
        <Field label="Requester" htmlFor="ticket-requester" required>
          <Combobox
            inputId="ticket-requester"
            value={requesterId}
            onValueChange={setRequesterId}
            search={requesterSearch}
            onSearchChange={setRequesterSearch}
            options={requesterOptions}
            placeholder="Search people…"
            emptyLabel="No people found."
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Priority" htmlFor="ticket-priority">
            <Select
              id="ticket-priority"
              value={priority}
              onChange={(e) => setPriority(e.currentTarget.value)}
              options={SUPPORT_TICKET_PRIORITY_OPTIONS}
            />
          </Field>
          <Field label="Channel" htmlFor="ticket-channel">
            <Select
              id="ticket-channel"
              value={channel}
              onChange={(e) => setChannel(e.currentTarget.value)}
              options={SUPPORT_TICKET_CHANNEL_OPTIONS}
            />
          </Field>
        </div>
        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
          <div className="mt-3 flex flex-col gap-4">
            <Field label="Description" htmlFor="ticket-description">
              <TextArea
                id="ticket-description"
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                placeholder="What's going on?"
              />
            </Field>
          </div>
        </details>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => router.push("/app/tickets")}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Create ticket"}
          </Button>
        </div>
      </form>
    </div>
  )
}
