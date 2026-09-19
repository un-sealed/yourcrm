"use client"

import { useCallback, useEffect, useState } from "react"
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Select,
  Skeleton,
  TextArea,
  TextField,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  dataRequestStatusLabel,
  dataRequestStatusTone,
  formatSettingsTimestamp,
  type DataRequest,
  type Paginated,
} from "./types"

/**
 * Data & privacy (spec 40, P0): GDPR/DPDP export and deletion requests.
 *
 * Two deliberate properties are visible to the admin here:
 *
 *  - An export is ASSEMBLED ON DEMAND. The request row stores ids only, so
 *    answering a subject access request never leaves a second copy of the
 *    person's data lying in the database.
 *  - A deletion SOFT-DELETES. The record disappears from the product and the
 *    request is kept as proof; the irreversible purge waits for a retention
 *    policy, and the UI says so rather than implying the data is gone.
 */

type ExportPayload = {
  requestId: string
  subjectId: string
  generatedAt: string
  record: Record<string, unknown>
}

export function PrivacySection() {
  const [requests, setRequests] = useState<DataRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [kind, setKind] = useState<"export" | "deletion">("export")
  const [subjectId, setSubjectId] = useState("")
  const [reason, setReason] = useState("")
  const [confirming, setConfirming] = useState(false)
  const [payload, setPayload] = useState<ExportPayload | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const page = await apiFetchRaw<Paginated<DataRequest>>(
        "/api/v1/settings/data-requests?limit=50",
      )
      setRequests(page.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load data requests.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const submit = async () => {
    setBusy(true)
    setActionError(null)
    try {
      await apiFetch<DataRequest>("/api/v1/settings/data-requests", {
        method: "POST",
        body: {
          kind,
          subjectType: "person",
          subjectId: subjectId.trim(),
          reason: reason.trim() === "" ? null : reason.trim(),
        },
      })
      setSubjectId("")
      setReason("")
      await load()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "That request could not be recorded.")
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  const download = async (request: DataRequest) => {
    setBusy(true)
    setActionError(null)
    try {
      setPayload(
        await apiFetch<ExportPayload>(`/api/v1/settings/data-requests/${request.id}/export`, {
          method: "POST",
        }),
      )
      await load()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "The export could not be assembled.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex max-w-2xl flex-col gap-3" aria-labelledby="privacy-new-heading">
        <h2 id="privacy-new-heading" className="text-lg font-semibold">
          New data request
        </h2>
        <p className="text-sm text-muted-foreground">
          Record a GDPR/DPDP subject access or erasure request for a person. Erasure soft-deletes
          the record immediately; the permanent purge follows your retention policy.
        </p>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            setConfirming(true)
          }}
        >
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Request type" htmlFor="request-kind">
              <Select
                id="request-kind"
                value={kind}
                className="w-44"
                options={[
                  { value: "export", label: "Export (access)" },
                  { value: "deletion", label: "Deletion (erasure)" },
                ]}
                onChange={(e) =>
                  setKind(e.currentTarget.value === "deletion" ? "deletion" : "export")
                }
              />
            </Field>
            <Field label="Person id" htmlFor="request-subject" className="min-w-80" required>
              <TextField
                id="request-subject"
                required
                value={subjectId}
                placeholder="00000000-0000-4000-8000-000000000000"
                onChange={(e) => setSubjectId(e.currentTarget.value)}
              />
            </Field>
          </div>
          <Field label="Reason" htmlFor="request-reason" hint="Stored with the request record.">
            <TextArea
              id="request-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
            />
          </Field>
          <div>
            <Button type="submit" disabled={busy || subjectId.trim() === ""}>
              Record request
            </Button>
          </div>
        </form>
        {actionError !== null ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {actionError}
          </p>
        ) : null}
      </section>

      {payload !== null ? (
        <section className="flex flex-col gap-2" aria-labelledby="privacy-export-heading">
          <h2 id="privacy-export-heading" className="text-lg font-semibold">
            Export for {payload.subjectId}
          </h2>
          <p className="text-xs text-muted-foreground">
            Assembled {formatSettingsTimestamp(payload.generatedAt)} — not stored anywhere.
          </p>
          <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
            {JSON.stringify(payload.record, null, 2)}
          </pre>
          <div>
            <Button size="sm" variant="ghost" onClick={() => setPayload(null)}>
              Dismiss
            </Button>
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-3" aria-labelledby="privacy-list-heading">
        <h2 id="privacy-list-heading" className="text-lg font-semibold">
          Requests
        </h2>
        {loading ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading data requests">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : error !== null ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : requests.length === 0 ? (
          <EmptyState
            title="No data requests yet"
            description="Export and deletion requests are recorded here for your compliance evidence."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {requests.map((request) => (
              <li
                key={request.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
              >
                <div>
                  <div className="font-medium">
                    {request.kind === "export" ? "Export" : "Deletion"} · {request.subjectType}{" "}
                    {request.subjectId}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    requested {formatSettingsTimestamp(request.createdAt)}
                    {request.reason === null ? "" : ` · ${request.reason}`}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={dataRequestStatusTone(request.status)}>
                    {dataRequestStatusLabel(request.status)}
                  </Badge>
                  {request.kind === "export" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void download(request)}
                    >
                      Assemble export
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={kind === "deletion" ? "Record an erasure request?" : "Record an export request?"}
        description={
          kind === "deletion"
            ? "The person record is soft-deleted immediately and hidden from the product. The request is kept as evidence; the permanent purge happens under your retention policy."
            : "The request is recorded now. The export itself is assembled on demand and is never stored."
        }
        confirmLabel={kind === "deletion" ? "Soft-delete and record" : "Record request"}
        danger={kind === "deletion"}
        loading={busy}
        onConfirm={() => void submit()}
      />
    </div>
  )
}
