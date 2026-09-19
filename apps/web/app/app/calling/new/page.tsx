"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button, Checkbox, Field, Select, TextArea, TextField, toast } from "@yourcrm/ui"
import { useUnsavedGuard } from "@/components/use-unsaved-guard"
import { ApiError, apiFetch } from "@/lib/api-client"
import { CALL_STATUS_LABELS, type CallRecord } from "../types"

const DIRECTION_OPTIONS = [
  { value: "outbound", label: "Outbound" },
  { value: "inbound", label: "Inbound" },
]

const STATUS_OPTIONS = Object.entries(CALL_STATUS_LABELS).map(([value, label]) => ({
  value,
  label,
}))

/** Manual call log: a rep records a call made outside the system. No provider connection needed. */
export default function NewCallPage() {
  const router = useRouter()
  const [direction, setDirection] = useState("outbound")
  const [status, setStatus] = useState("completed")
  const [fromNumber, setFromNumber] = useState("")
  const [toNumber, setToNumber] = useState("")
  const [durationSeconds, setDurationSeconds] = useState("")
  const [disposition, setDisposition] = useState("")
  const [notes, setNotes] = useState("")
  const [recordingConsent, setRecordingConsent] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const dirty =
    fromNumber !== "" ||
    toNumber !== "" ||
    disposition !== "" ||
    notes !== "" ||
    durationSeconds !== ""
  useUnsavedGuard(dirty && !saving)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (fromNumber.trim() === "" || toNumber.trim() === "") {
      setFieldError("From and to numbers are required.")
      return
    }
    setFieldError(null)
    setSaving(true)
    try {
      const call = await apiFetch<CallRecord>("/api/v1/calling/log", {
        method: "POST",
        body: {
          direction,
          status,
          fromNumber: fromNumber.trim(),
          toNumber: toNumber.trim(),
          ...(durationSeconds.trim() === "" ? {} : { durationSeconds: Number(durationSeconds) }),
          ...(disposition.trim() === "" ? {} : { disposition: disposition.trim() }),
          ...(notes.trim() === "" ? {} : { notes: notes.trim() }),
          recordingConsent,
        },
      })
      toast({ title: "Call logged" })
      router.push(`/app/calling/${call.id}`)
    } catch (err) {
      setFieldError(err instanceof ApiError ? err.message : "Could not log this call.")
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Log a call</h1>
        <Link href="/app/calling" className="text-sm text-muted-foreground hover:underline">
          Back to calling
        </Link>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Direction" htmlFor="direction" required>
            <Select
              id="direction"
              value={direction}
              onChange={(e) => setDirection(e.currentTarget.value)}
              options={DIRECTION_OPTIONS}
            />
          </Field>
          <Field label="Outcome" htmlFor="status" required>
            <Select
              id="status"
              value={status}
              onChange={(e) => setStatus(e.currentTarget.value)}
              options={STATUS_OPTIONS}
            />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="From number" htmlFor="from-number" required error={fieldError}>
            <TextField
              id="from-number"
              type="tel"
              value={fromNumber}
              onChange={(e) => setFromNumber(e.currentTarget.value)}
              placeholder="+1 415 555 0100"
              required
              invalid={fieldError !== null && fromNumber.trim() === ""}
            />
          </Field>
          <Field label="To number" htmlFor="to-number" required>
            <TextField
              id="to-number"
              type="tel"
              value={toNumber}
              onChange={(e) => setToNumber(e.currentTarget.value)}
              placeholder="+1 415 555 0199"
              required
              invalid={fieldError !== null && toNumber.trim() === ""}
            />
          </Field>
        </div>
        <Field label="Duration (seconds)" htmlFor="duration">
          <TextField
            id="duration"
            type="number"
            min={0}
            value={durationSeconds}
            onChange={(e) => setDurationSeconds(e.currentTarget.value)}
            placeholder="180"
          />
        </Field>
        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
          <div className="mt-3 flex flex-col gap-4">
            <Field label="Disposition" htmlFor="disposition">
              <TextField
                id="disposition"
                value={disposition}
                onChange={(e) => setDisposition(e.currentTarget.value)}
                placeholder="Interested, follow up next week"
              />
            </Field>
            <Field label="Notes" htmlFor="notes">
              <TextArea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.currentTarget.value)}
                placeholder="What happened on this call…"
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={recordingConsent}
                onChange={(e) => setRecordingConsent(e.currentTarget.checked)}
              />
              This call was recorded with consent
            </label>
          </div>
        </details>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => router.push("/app/calling")}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Log call"}
          </Button>
        </div>
      </form>
    </div>
  )
}
