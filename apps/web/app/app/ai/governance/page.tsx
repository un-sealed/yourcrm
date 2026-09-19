"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Select,
  Skeleton,
  TextArea,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  aiDiffRows,
  canDecide,
  canRevert,
  describeAiProposer,
  describeAiRequest,
  formatAiTimestamp,
  AI_ACTION_LABELS,
  AI_STATUS_TONES,
  type AiActionRequest,
  type AiActionRequestsResponse,
} from "./types"

/**
 * AI approval queue (spec 38, P0).
 *
 * The page a human uses to stay in control of AI: what is waiting, what
 * exactly it would change, and approve or reject with a reason. Applied
 * actions stay visible so they can be undone.
 *
 * Every control here is a convenience. The server refuses self-approval,
 * refuses an approver who could not make the change by hand, and applies
 * exactly once — this page only has to be honest about what it is asking.
 */

const STATUS_OPTIONS = [
  { value: "pending", label: "Waiting for review" },
  { value: "applied", label: "Applied" },
  { value: "rejected", label: "Rejected" },
  { value: "approved", label: "Approved, not applied" },
  { value: "reverted", label: "Undone" },
  { value: "expired", label: "Expired" },
  { value: "", label: "Everything" },
]

type PendingDecision = { request: AiActionRequest; decision: "approve" | "reject" | "revert" }

export default function AiGovernancePage() {
  const [rows, setRows] = useState<AiActionRequest[]>([])
  const [status, setStatus] = useState("pending")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [decision, setDecision] = useState<PendingDecision | null>(null)
  const [reason, setReason] = useState("")
  const [working, setWorking] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (status !== "") qs.set("status", status)
      const res = await apiFetchRaw<AiActionRequestsResponse>(
        `/api/v1/ai/governance/requests?${qs.toString()}`,
      )
      setRows(res.data)
      setSelectedId((current) =>
        current !== null && res.data.some((r) => r.id === current)
          ? current
          : (res.data[0]?.id ?? null),
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the AI approval queue.")
    } finally {
      setLoading(false)
    }
  }, [status])

  useEffect(() => {
    void load()
  }, [load])

  const selected = useMemo(
    () => rows.find((row) => row.id === selectedId) ?? null,
    [rows, selectedId],
  )

  const openDecision = (request: AiActionRequest, kind: PendingDecision["decision"]) => {
    setReason("")
    setActionError(null)
    setDecision({ request, decision: kind })
  }

  const submitDecision = async () => {
    if (decision === null) return
    if (decision.decision === "reject" && reason.trim() === "") {
      setActionError("Say why you are rejecting it — the proposer will see this.")
      return
    }
    setWorking(true)
    setActionError(null)
    try {
      await apiFetch(`/api/v1/ai/governance/requests/${decision.request.id}/${decision.decision}`, {
        method: "POST",
        body: reason.trim() === "" ? {} : { reason: reason.trim() },
      })
      setDecision(null)
      setReason("")
      await load()
    } catch (err) {
      setActionError(
        err instanceof ApiError
          ? err.code === "FORBIDDEN"
            ? `${err.message}`
            : err.message
          : "Could not record that decision.",
      )
    } finally {
      setWorking(false)
    }
  }

  if (error !== null) {
    return <ErrorState message={error} onRetry={() => void load()} />
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">AI approvals</h1>
          <p className="text-sm text-muted-foreground">
            Nothing an AI proposes touches a record until a person approves it here.
          </p>
        </div>
        <Select
          className="max-w-[16rem]"
          aria-label="Filter by status"
          value={status}
          onChange={(e) => {
            setSelectedId(null)
            setStatus(e.target.value)
          }}
          options={STATUS_OPTIONS}
        />
      </header>

      {actionError !== null && decision === null ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      {loading ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading AI approvals">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing is waiting for you"
          description={
            status === "pending"
              ? "When an AI agent proposes a change, it appears here with a diff before anything happens."
              : "No AI actions match that filter."
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <ul className="flex flex-col gap-2" aria-label="Proposed AI actions">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(row.id)}
                  aria-current={row.id === selectedId}
                  className={`w-full rounded-md border p-3 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    row.id === selectedId ? "border-primary bg-muted/40" : "border-border"
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium">{describeAiRequest(row)}</span>
                    <Badge tone={AI_STATUS_TONES[row.status] ?? "secondary"}>{row.status}</Badge>
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {describeAiProposer(row)} · {formatAiTimestamp(row.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {selected === null ? (
            <EmptyState title="Pick a proposal" description="Select one to see what it changes." />
          ) : (
            <AiRequestDetail request={selected} working={working} onDecide={openDecision} />
          )}
        </div>
      )}

      <Dialog
        open={decision !== null}
        onOpenChange={(open) => {
          if (!open) setDecision(null)
        }}
        title={
          decision?.decision === "approve"
            ? "Approve and apply this change?"
            : decision?.decision === "reject"
              ? "Reject this proposal?"
              : "Undo this AI change?"
        }
        description={
          decision === null
            ? undefined
            : decision.decision === "approve"
              ? "It will be applied immediately, with your name on it, using your permissions and the proposer's."
              : decision.decision === "reject"
                ? "The proposer sees your reason. Nothing is applied."
                : "The recorded before-state is written back through the normal update path."
        }
      >
        <div className="flex flex-col gap-3">
          <Field
            label="Reason"
            htmlFor="ai-decision-reason"
            required={decision?.decision === "reject"}
            hint={
              decision?.decision === "reject"
                ? "Required — this is the feedback loop for the agent."
                : "Optional, and kept in the audit trail."
            }
          >
            <TextArea
              id="ai-decision-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What did you check?"
            />
          </Field>
          {actionError !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {actionError}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDecision(null)} disabled={working}>
              Cancel
            </Button>
            <Button
              variant={decision?.decision === "approve" ? "default" : "destructive"}
              onClick={() => void submitDecision()}
              disabled={working}
            >
              {decision?.decision === "approve"
                ? "Approve and apply"
                : decision?.decision === "reject"
                  ? "Reject"
                  : "Undo"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}

function AiRequestDetail({
  request,
  working,
  onDecide,
}: {
  request: AiActionRequest
  working: boolean
  onDecide: (request: AiActionRequest, decision: "approve" | "reject" | "revert") => void
}) {
  const rows = aiDiffRows(request.before, request.after)
  return (
    <section className="flex flex-col gap-4 rounded-md border border-border p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">
            {AI_ACTION_LABELS[request.action] ?? request.action} {request.objectType}
          </h2>
          <p className="text-sm text-muted-foreground">
            {describeAiProposer(request)}
            {request.runId === null ? "" : ` · run ${request.runId}`}
            {request.recordId === null ? "" : ` · record ${request.recordId}`}
          </p>
        </div>
        <Badge tone={AI_STATUS_TONES[request.status] ?? "secondary"}>{request.status}</Badge>
      </header>

      {request.rationale === null ? null : (
        <p className="rounded-md bg-muted/40 p-3 text-sm">
          <span className="font-medium">Why: </span>
          {request.rationale}
        </p>
      )}

      <div>
        <h3 className="mb-2 text-sm font-medium">What would change</h3>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This proposal records no field-level diff.
          </p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Proposed changes, field by field</caption>
            <thead>
              <tr className="text-left text-xs uppercase text-muted-foreground">
                <th scope="col" className="py-1 pr-2 font-medium">
                  Field
                </th>
                <th scope="col" className="py-1 pr-2 font-medium">
                  Now
                </th>
                <th scope="col" className="py-1 font-medium">
                  Proposed
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.field} className="border-t border-border align-top">
                  <th scope="row" className="py-2 pr-2 text-left font-normal">
                    {row.field}
                  </th>
                  <td className="py-2 pr-2 text-muted-foreground line-through decoration-muted-foreground/50">
                    {row.before}
                  </td>
                  <td className="py-2">
                    {row.changed ? (
                      <span className="font-medium">{row.after}</span>
                    ) : (
                      <span className="text-muted-foreground">{row.after}</span>
                    )}
                    {row.changed ? <span className="sr-only"> (changed)</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-2 text-sm">
        <dt className="text-muted-foreground">Proposed</dt>
        <dd>{formatAiTimestamp(request.createdAt)}</dd>
        <dt className="text-muted-foreground">Policy</dt>
        <dd>{request.policyMode}</dd>
        {request.expiresAt === null ? null : (
          <>
            <dt className="text-muted-foreground">Expires</dt>
            <dd>{formatAiTimestamp(request.expiresAt)}</dd>
          </>
        )}
        {request.appliedAt === null ? null : (
          <>
            <dt className="text-muted-foreground">Applied</dt>
            <dd>{formatAiTimestamp(request.appliedAt)}</dd>
          </>
        )}
      </dl>

      {request.applyError === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          The change could not be applied: {request.applyError}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {canDecide(request) ? (
          <>
            <Button disabled={working} onClick={() => onDecide(request, "approve")}>
              Approve and apply
            </Button>
            <Button
              variant="outline"
              disabled={working}
              onClick={() => onDecide(request, "reject")}
            >
              Reject
            </Button>
          </>
        ) : null}
        {canRevert(request) ? (
          <Button
            variant="destructive"
            disabled={working}
            onClick={() => onDecide(request, "revert")}
          >
            Undo this change
          </Button>
        ) : null}
      </div>
    </section>
  )
}
