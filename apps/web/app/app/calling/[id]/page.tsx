"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  RecordHeader,
  Skeleton,
  Tabs,
  TextArea,
  TextField,
  Timeline,
  toast,
} from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"
import { CALL_STATUS_LABELS, statusTone, type CallDetail } from "../types"

/** Call detail: header with status/actions, editable disposition/notes, recordings (consent-gated), timeline. */
export default function CallDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const [detail, setDetail] = useState<CallDetail | null>(null)
  const [tab, setTab] = useState("overview")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [disposition, setDisposition] = useState("")
  const [notes, setNotes] = useState("")
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<CallDetail>(`/api/v1/calling/${id}`)
      setDetail(data)
      setDisposition(data.call.disposition ?? "")
      setNotes(data.call.notes ?? "")
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this call.")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      await apiFetch(`/api/v1/calling/${id}`, {
        method: "PATCH",
        body: {
          disposition: disposition.trim() === "" ? null : disposition.trim(),
          notes: notes.trim() === "" ? null : notes.trim(),
        },
      })
      toast({ title: "Call updated" })
      await load()
    } catch (err) {
      toast({
        title: "Update failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading call">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error !== null || detail === null) {
    return <ErrorState message={error ?? "This call does not exist."} onRetry={() => void load()} />
  }

  const { call, recordings } = detail

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/calling" className="text-sm text-muted-foreground hover:underline">
        ← Back to calling
      </Link>
      <RecordHeader
        title={`${call.direction === "inbound" ? "Inbound" : "Outbound"} call`}
        subtitle={`${call.fromNumber} → ${call.toNumber}`}
        status={{ label: CALL_STATUS_LABELS[call.status], tone: statusTone(call.status) }}
        owner={undefined}
        actions={
          <a href={`tel:${call.direction === "inbound" ? call.fromNumber : call.toNumber}`}>
            <Button variant="outline" size="sm">
              Call again
            </Button>
          </a>
        }
      />

      <Tabs
        value={tab}
        onValueChange={setTab}
        ariaLabel="Call sections"
        items={[
          {
            value: "overview",
            label: "Overview",
            content: (
              <div className="grid gap-6 py-4 lg:grid-cols-2">
                <section aria-label="Call properties" className="flex flex-col gap-3">
                  <h2 className="text-sm font-semibold">Properties</h2>
                  <dl className="flex flex-col gap-2 text-sm">
                    <div className="flex items-center gap-2">
                      <dt className="w-32 shrink-0 text-muted-foreground">Source</dt>
                      <dd>{call.source === "manual" ? "Manually logged" : "Click-to-call"}</dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-32 shrink-0 text-muted-foreground">Duration</dt>
                      <dd>{call.durationSeconds !== null ? `${call.durationSeconds}s` : "—"}</dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-32 shrink-0 text-muted-foreground">Recording consent</dt>
                      <dd>
                        <Badge tone={call.recordingConsent ? "success" : "secondary"}>
                          {call.recordingConsent ? "Granted" : "Not granted"}
                        </Badge>
                      </dd>
                    </div>
                    {call.errorMessage ? (
                      <div className="flex items-center gap-2">
                        <dt className="w-32 shrink-0 text-muted-foreground">Provider error</dt>
                        <dd className="text-destructive">{call.errorMessage}</dd>
                      </div>
                    ) : null}
                  </dl>

                  <h2 className="mt-2 text-sm font-semibold">Recordings</h2>
                  {recordings.length === 0 ? (
                    <EmptyState
                      title="No recordings"
                      description={
                        call.recordingConsent
                          ? "No recording has been attached to this call yet."
                          : "Recording consent has not been granted for this call."
                      }
                    />
                  ) : (
                    <ul className="flex flex-col gap-2 text-sm">
                      {recordings.map((recording) => (
                        <li key={recording.id} className="flex items-center gap-2">
                          <a
                            href={recording.url}
                            className="text-primary hover:underline"
                            target="_blank"
                            rel="noreferrer"
                          >
                            Recording
                          </a>
                          {recording.durationSeconds !== null ? (
                            <span className="text-muted-foreground">
                              {recording.durationSeconds}s
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section aria-label="Edit call">
                  <h2 className="mb-3 text-sm font-semibold">Edit</h2>
                  <form onSubmit={save} className="flex flex-col gap-3">
                    <Field label="Disposition" htmlFor="call-disposition">
                      <TextField
                        id="call-disposition"
                        value={disposition}
                        onChange={(e) => setDisposition(e.currentTarget.value)}
                      />
                    </Field>
                    <Field label="Notes" htmlFor="call-notes">
                      <TextArea
                        id="call-notes"
                        value={notes}
                        onChange={(e) => setNotes(e.currentTarget.value)}
                      />
                    </Field>
                    <div>
                      <Button type="submit" disabled={saving}>
                        {saving ? "Saving…" : "Save changes"}
                      </Button>
                    </div>
                  </form>
                </section>
              </div>
            ),
          },
          {
            value: "activity",
            label: "Activity",
            content: (
              <div className="py-4">
                <Timeline
                  items={[
                    {
                      id: "created",
                      actor: "System",
                      timestamp: new Date(call.createdAt).toLocaleString(),
                      dateTime: call.createdAt,
                      body: `Call logged (${call.source === "manual" ? "manual" : "click-to-call"}).`,
                    },
                    ...(call.startedAt
                      ? [
                          {
                            id: "started",
                            actor: "System",
                            timestamp: new Date(call.startedAt).toLocaleString(),
                            dateTime: call.startedAt,
                            body: "Call started.",
                          },
                        ]
                      : []),
                    ...(call.endedAt
                      ? [
                          {
                            id: "ended",
                            actor: "System",
                            timestamp: new Date(call.endedAt).toLocaleString(),
                            dateTime: call.endedAt,
                            body: `Call ended (${CALL_STATUS_LABELS[call.status]}).`,
                          },
                        ]
                      : []),
                  ]}
                />
              </div>
            ),
          },
        ]}
      />
    </div>
  )
}
