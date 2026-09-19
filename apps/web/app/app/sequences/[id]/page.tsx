"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  Badge,
  Button,
  buttonVariants,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Skeleton,
  TextField,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  areSequenceStepsValid,
  SequenceStepEditor,
  toSequenceStepDraft,
  toSequenceStepsPayload,
  type SequenceStepDraft,
} from "../step-editor"
import {
  enrollmentStatusTone,
  exitReasonLabel,
  formatSequenceTimestamp,
  nextSequenceStatuses,
  sequenceStatusTone,
  summarizeSequenceStats,
  SEQUENCE_STATUS_LABELS,
  type Sequence,
  type SequenceCatalogue,
  type SequenceDetail,
  type SequenceEnrollment,
  type SequenceEnrollmentListResponse,
  type SequenceStats,
  type SequenceStatus,
} from "../types"

/**
 * Sequence detail (spec 47 §4, P0): the step editor, the enrollment list
 * and the stop controls, on one page.
 *
 * Three things this page is careful about:
 *  - ACTIVATING is a deliberate, confirmed act. It is what starts sending.
 *  - Every list refetches after a mutation rather than patching state
 *    optimistically: whether a drip is still running is a server fact
 *    (the prospect may have replied a second ago), and guessing it wrong
 *    is exactly the failure this module exists to prevent.
 *  - Editing a live sequence is allowed and says so. Steps somebody has
 *    already passed are never re-sent.
 */
export default function SequenceDetailPage() {
  const params = useParams<{ id: string }>()
  const id = typeof params.id === "string" ? params.id : ""
  const router = useRouter()

  const [sequence, setSequence] = useState<SequenceDetail | null>(null)
  const [catalogue, setCatalogue] = useState<SequenceCatalogue | null>(null)
  const [stats, setStats] = useState<SequenceStats | null>(null)
  const [enrollments, setEnrollments] = useState<SequenceEnrollment[]>([])
  const [steps, setSteps] = useState<SequenceStepDraft[]>([])
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [personId, setPersonId] = useState("")
  const [confirmActivate, setConfirmActivate] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    if (id === "") return
    setLoading(true)
    setError(null)
    try {
      const detail = await apiFetch<SequenceDetail>(`/api/v1/sequences/${id}`)
      setSequence(detail)
      setSteps(detail.steps.map(toSequenceStepDraft))
      setDirty(false)
      const [enrolled, counters] = await Promise.all([
        apiFetchRaw<SequenceEnrollmentListResponse>(`/api/v1/sequences/${id}/enrollments`),
        apiFetch<SequenceStats>(`/api/v1/sequences/${id}/stats`),
      ])
      setEnrollments(enrolled.data)
      setStats(counters)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this sequence.")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    apiFetch<SequenceCatalogue>("/api/v1/sequences/catalogue")
      .then(setCatalogue)
      .catch(() => {
        // The catalogue only supplies labels and limits; the editor works
        // without it, and the server validates either way.
      })
  }, [])

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])

  const describeError = (err: unknown, fallback: string): string => {
    if (!(err instanceof ApiError)) return fallback
    if (err.code === "FORBIDDEN") {
      return "You do not have permission to do that. Activating a sequence needs permission to send email on the workspace's behalf."
    }
    return err.message
  }

  const saveSteps = async () => {
    setWorking(true)
    setActionError(null)
    try {
      await apiFetchRaw(`/api/v1/sequences/${id}/steps`, {
        method: "PUT",
        body: toSequenceStepsPayload(steps),
      })
      await load()
    } catch (err) {
      setActionError(describeError(err, "Could not save those steps."))
    } finally {
      setWorking(false)
    }
  }

  const setStatus = async (status: SequenceStatus) => {
    setWorking(true)
    setActionError(null)
    try {
      await apiFetch<Sequence>(`/api/v1/sequences/${id}/status`, {
        method: "POST",
        body: { status },
      })
      await load()
    } catch (err) {
      setActionError(describeError(err, "Could not change the status."))
    } finally {
      setWorking(false)
      setConfirmActivate(false)
    }
  }

  const enroll = async () => {
    setWorking(true)
    setActionError(null)
    try {
      await apiFetchRaw(`/api/v1/sequences/${id}/enrollments`, {
        method: "POST",
        body: { personId: personId.trim() },
      })
      setPersonId("")
      await load()
    } catch (err) {
      setActionError(describeError(err, "Could not enrol that person."))
    } finally {
      setWorking(false)
    }
  }

  const enrollmentAction = async (enrollment: SequenceEnrollment, path: string, body?: unknown) => {
    setWorking(true)
    setActionError(null)
    try {
      await apiFetchRaw(`/api/v1/sequences/enrollments/${enrollment.id}${path}`, {
        method: "POST",
        body: body ?? {},
      })
      await load()
    } catch (err) {
      setActionError(describeError(err, "That action could not be completed."))
    } finally {
      setWorking(false)
    }
  }

  const remove = async () => {
    setWorking(true)
    setActionError(null)
    try {
      await apiFetchRaw(`/api/v1/sequences/${id}`, { method: "DELETE" })
      router.push("/app/sequences")
    } catch (err) {
      setActionError(describeError(err, "Could not delete this sequence."))
      setWorking(false)
      setConfirmDelete(false)
    }
  }

  if (error !== null) return <ErrorState message={error} onRetry={() => void load()} />

  if (loading && sequence === null) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading sequence">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  if (sequence === null) {
    return (
      <EmptyState
        title="Sequence not found"
        description="It may have been deleted, or it belongs to another workspace."
        action={
          <Link href="/app/sequences" className={buttonVariants()}>
            Back to sequences
          </Link>
        }
      />
    )
  }

  const counters = summarizeSequenceStats(stats)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold">{sequence.name}</h1>
            <Badge tone={sequenceStatusTone(sequence.status)}>
              {SEQUENCE_STATUS_LABELS[sequence.status] ?? sequence.status}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {sequence.description ?? "No description"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Stops on {sequence.exitOnReply ? "reply" : "no reply"}
            {sequence.exitOnBounce ? ", bounce" : ""}, unsubscribe and manual removal.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {nextSequenceStatuses(sequence).map((status) => (
            <Button
              key={status}
              variant={status === "active" ? "default" : "outline"}
              size="sm"
              disabled={working}
              onClick={() =>
                status === "active" ? setConfirmActivate(true) : void setStatus(status)
              }
            >
              {status === "active"
                ? "Activate"
                : status === "paused"
                  ? "Pause"
                  : status === "archived"
                    ? "Archive"
                    : "Back to draft"}
            </Button>
          ))}
          <Button
            variant="outline"
            size="sm"
            disabled={working}
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </Button>
        </div>
      </header>

      <dl className="grid gap-2 sm:grid-cols-4">
        {[
          { label: "Enrolled", value: counters.enrolled },
          { label: "Active", value: counters.active },
          { label: "Stopped", value: counters.stopped },
          { label: "Emails sent", value: counters.sent },
        ].map((tile) => (
          <div key={tile.label} className="rounded-lg border px-4 py-3">
            <dt className="text-xs text-muted-foreground">{tile.label}</dt>
            <dd className="text-xl font-semibold">{tile.value}</dd>
          </div>
        ))}
      </dl>

      {actionError !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Steps</h2>
          <Button
            size="sm"
            disabled={working || !dirty || !areSequenceStepsValid(steps)}
            onClick={() => void saveSteps()}
          >
            {working ? "Saving…" : "Save steps"}
          </Button>
        </div>
        {sequence.status === "active" ? (
          <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
            This sequence is live. Editing is safe — anyone who has already passed a step will never
            receive it again — but changes apply to everybody still ahead of it.
          </p>
        ) : null}
        <SequenceStepEditor
          steps={steps}
          catalogue={catalogue}
          disabled={working}
          onChange={(next) => {
            setSteps(next)
            setDirty(true)
          }}
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Enrollments</h2>

        <div className="flex flex-wrap items-end gap-2">
          <Field
            label="Enrol a person"
            htmlFor="enrol-person"
            hint="Paste a person id from People. A picker lands with the shared person search."
            className="w-80"
          >
            <TextField
              id="enrol-person"
              value={personId}
              disabled={working || sequence.status !== "active"}
              placeholder="person id"
              onChange={(e) => setPersonId(e.currentTarget.value)}
            />
          </Field>
          <Button
            size="sm"
            disabled={working || personId.trim() === "" || sequence.status !== "active"}
            onClick={() => void enroll()}
          >
            Enrol
          </Button>
          <Link href="/app/people" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Find people
          </Link>
        </div>
        {sequence.status !== "active" ? (
          <p className="text-sm text-muted-foreground">
            Activate the sequence before enrolling anybody.
          </p>
        ) : null}

        {enrollments.length === 0 ? (
          <EmptyState
            title="Nobody is enrolled yet"
            description="Enrol a person above. Their first step runs after the delay you set on step 1."
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border">
            {enrollments.map((enrollment) => (
              <li
                key={enrollment.id}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{enrollment.emailAddress}</span>
                    <Badge tone={enrollmentStatusTone(enrollment.status)}>
                      {enrollment.status}
                    </Badge>
                    {enrollment.exitReason !== null ? (
                      <Badge tone="outline">{exitReasonLabel(enrollment.exitReason)}</Badge>
                    ) : null}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    Step {enrollment.currentStepIndex + 1} · {enrollment.sentCount} sent · next{" "}
                    {formatSequenceTimestamp(enrollment.nextRunAt)}
                  </span>
                  {enrollment.error !== null ? (
                    <span className="text-sm text-destructive">{enrollment.error}</span>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {enrollment.status === "active" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={working}
                      onClick={() => void enrollmentAction(enrollment, "/pause")}
                    >
                      Pause
                    </Button>
                  ) : null}
                  {enrollment.status === "paused" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={working}
                      onClick={() => void enrollmentAction(enrollment, "/resume")}
                    >
                      Resume
                    </Button>
                  ) : null}
                  {enrollment.status === "active" || enrollment.status === "paused" ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={working}
                        onClick={() =>
                          void enrollmentAction(enrollment, "/stop", { reason: "removed" })
                        }
                      >
                        Remove
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={working}
                        onClick={() =>
                          void enrollmentAction(enrollment, "/stop", { reason: "unsubscribed" })
                        }
                      >
                        Unsubscribe
                      </Button>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={confirmActivate}
        onOpenChange={setConfirmActivate}
        title="Activate this sequence?"
        description="Activating lets it send email to everybody you enrol, as its owner. It stops automatically when somebody replies, bounces or unsubscribes."
        confirmLabel="Activate"
        loading={working}
        onConfirm={() => void setStatus("active")}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this sequence?"
        description="Every live enrollment stops first, so nobody receives another step. The history stays in the audit log."
        confirmLabel="Delete"
        danger
        loading={working}
        onConfirm={() => void remove()}
      />
    </div>
  )
}
