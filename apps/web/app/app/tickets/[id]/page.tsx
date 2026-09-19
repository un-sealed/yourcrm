"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  RecordHeader,
  Select,
  Skeleton,
  Tabs,
  TextArea,
  TextField,
  Timeline,
  toast,
} from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"
import {
  priorityTone,
  statusTone,
  SUPPORT_TICKET_CHANNEL_OPTIONS,
  SUPPORT_TICKET_NEXT_STATUSES,
  SUPPORT_TICKET_PRIORITY_OPTIONS,
  type SupportTicketDetail,
} from "../types"

/**
 * Ticket detail: header with status-transition actions, tabbed overview
 * (edit) / comments (thread + compose) / activity, delete. Status only ever
 * changes through `POST /:id/status` (never the generic PATCH used for the
 * Overview form) — see `packages/crm/src/support/service.ts` for why.
 */
export default function TicketDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id
  const [ticket, setTicket] = useState<SupportTicketDetail | null>(null)
  const [tab, setTab] = useState("overview")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [subject, setSubject] = useState("")
  const [description, setDescription] = useState("")
  const [priority, setPriority] = useState("normal")
  const [channel, setChannel] = useState("manual")
  const [assigneeId, setAssigneeId] = useState("")
  const [saving, setSaving] = useState(false)
  const [transitioning, setTransitioning] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [commentBody, setCommentBody] = useState("")
  const [commentInternal, setCommentInternal] = useState(false)
  const [postingComment, setPostingComment] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<SupportTicketDetail>(`/api/v1/tickets/${id}`)
      setTicket(data)
      setSubject(data.subject)
      setDescription(data.description ?? "")
      setPriority(data.priority)
      setChannel(data.channel)
      setAssigneeId(data.assigneeId ?? "")
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this ticket.")
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
      await apiFetch<SupportTicketDetail>(`/api/v1/tickets/${id}`, {
        method: "PATCH",
        body: {
          subject: subject.trim(),
          description: description.trim() === "" ? null : description.trim(),
          priority,
          channel,
          assigneeId: assigneeId.trim() === "" ? null : assigneeId.trim(),
        },
      })
      await load()
      toast({ title: "Ticket updated" })
    } catch (err) {
      toast({
        title: "Update failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setSaving(false)
    }
  }

  const doTransition = async (status: string) => {
    setTransitioning(true)
    try {
      await apiFetch<SupportTicketDetail>(`/api/v1/tickets/${id}/status`, {
        method: "POST",
        body: { status },
      })
      await load()
      toast({ title: `Ticket marked ${status}` })
    } catch (err) {
      toast({
        title: "That transition isn't allowed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setTransitioning(false)
    }
  }

  const postComment = async (e: React.FormEvent) => {
    e.preventDefault()
    if (commentBody.trim() === "") return
    setPostingComment(true)
    try {
      await apiFetch(`/api/v1/tickets/${id}/comments`, {
        method: "POST",
        body: { body: commentBody.trim(), isInternal: commentInternal },
      })
      setCommentBody("")
      setCommentInternal(false)
      await load()
    } catch (err) {
      toast({
        title: "Could not post comment",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setPostingComment(false)
    }
  }

  const remove = async () => {
    try {
      await apiFetch(`/api/v1/tickets/${id}`, { method: "DELETE" })
      toast({ title: "Ticket deleted", description: "It can be restored from trash." })
      router.push("/app/tickets")
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading ticket">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error !== null || ticket === null) {
    return (
      <ErrorState message={error ?? "This ticket does not exist."} onRetry={() => void load()} />
    )
  }

  const nextStatuses = SUPPORT_TICKET_NEXT_STATUSES[ticket.status] ?? []

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/tickets" className="text-sm text-muted-foreground hover:underline">
        ← Back to tickets
      </Link>
      <RecordHeader
        title={ticket.subject}
        subtitle={`${ticket.channel} · priority ${ticket.priority}`}
        status={{ label: ticket.status, tone: statusTone(ticket.status) }}
        owner={undefined}
        actions={
          <>
            {nextStatuses.map((status) => (
              <Button
                key={status}
                variant="outline"
                size="sm"
                onClick={() => void doTransition(status)}
                disabled={transitioning}
              >
                {transitioning ? "Updating…" : `Mark ${status}`}
              </Button>
            ))}
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </>
        }
      />

      <Tabs
        value={tab}
        onValueChange={setTab}
        ariaLabel="Ticket sections"
        items={[
          {
            value: "overview",
            label: "Overview",
            content: (
              <div className="grid gap-6 py-4 lg:grid-cols-2">
                <section aria-label="Ticket properties" className="flex flex-col gap-3">
                  <h2 className="text-sm font-semibold">Properties</h2>
                  <dl className="flex flex-col gap-2 text-sm">
                    <div className="flex items-center gap-2">
                      <dt className="w-32 shrink-0 text-muted-foreground">Priority</dt>
                      <dd>
                        <Badge tone={priorityTone(ticket.priority)}>{ticket.priority}</Badge>
                      </dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-32 shrink-0 text-muted-foreground">Requester</dt>
                      <dd>{ticket.requesterId}</dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-32 shrink-0 text-muted-foreground">Assignee</dt>
                      <dd>
                        {ticket.assigneeId ?? (
                          <span className="text-muted-foreground">Unassigned</span>
                        )}
                      </dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-32 shrink-0 text-muted-foreground">First response due</dt>
                      <dd>
                        {ticket.firstResponseAt !== null
                          ? `Responded ${new Date(ticket.firstResponseAt).toLocaleString()}`
                          : ticket.firstResponseDueAt !== null
                            ? new Date(ticket.firstResponseDueAt).toLocaleString()
                            : "—"}
                      </dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-32 shrink-0 text-muted-foreground">Resolution due</dt>
                      <dd>
                        {ticket.resolvedAt !== null
                          ? `Resolved ${new Date(ticket.resolvedAt).toLocaleString()}`
                          : ticket.resolutionDueAt !== null
                            ? new Date(ticket.resolutionDueAt).toLocaleString()
                            : "—"}
                      </dd>
                    </div>
                  </dl>
                  {ticket.description ? (
                    <div className="flex flex-col gap-1">
                      <h3 className="text-sm font-semibold">Description</h3>
                      <p className="whitespace-pre-wrap text-sm">{ticket.description}</p>
                    </div>
                  ) : null}
                </section>
                <section aria-label="Edit ticket">
                  <h2 className="mb-3 text-sm font-semibold">Edit</h2>
                  <form onSubmit={save} className="flex flex-col gap-3">
                    <Field label="Subject" htmlFor="ticket-subject">
                      <TextField
                        id="ticket-subject"
                        value={subject}
                        onChange={(e) => setSubject(e.currentTarget.value)}
                      />
                    </Field>
                    <Field label="Description" htmlFor="ticket-description">
                      <TextArea
                        id="ticket-description"
                        value={description}
                        onChange={(e) => setDescription(e.currentTarget.value)}
                      />
                    </Field>
                    <div className="grid gap-3 sm:grid-cols-2">
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
                    <Field label="Assignee (user id)" htmlFor="ticket-assignee">
                      <TextField
                        id="ticket-assignee"
                        value={assigneeId}
                        onChange={(e) => setAssigneeId(e.currentTarget.value)}
                        placeholder="Unassigned"
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
            value: "comments",
            label: `Comments (${ticket.comments.length})`,
            content: (
              <div className="flex flex-col gap-4 py-4">
                {ticket.comments.length === 0 ? (
                  <EmptyState
                    title="No comments yet"
                    description="Reply to the requester or leave an internal note for the team."
                  />
                ) : (
                  <Timeline
                    items={ticket.comments.map((comment) => ({
                      id: comment.id,
                      actor: comment.isInternal ? "Internal note" : "Reply",
                      timestamp: new Date(comment.createdAt).toLocaleString(),
                      dateTime: comment.createdAt,
                      body: (
                        <div className="flex flex-col gap-1">
                          {comment.isInternal ? (
                            <Badge tone="warning" className="w-fit">
                              Internal — staff only
                            </Badge>
                          ) : null}
                          <p className="whitespace-pre-wrap">{comment.body}</p>
                        </div>
                      ),
                    }))}
                  />
                )}
                <form
                  onSubmit={postComment}
                  className="flex flex-col gap-3 border-t border-border pt-4"
                >
                  <Field label="Add a comment" htmlFor="ticket-comment-body">
                    <TextArea
                      id="ticket-comment-body"
                      value={commentBody}
                      onChange={(e) => setCommentBody(e.currentTarget.value)}
                      placeholder="Reply to the requester, or check Internal to leave a staff-only note…"
                    />
                  </Field>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      id="ticket-comment-internal"
                      checked={commentInternal}
                      onChange={(e) => setCommentInternal(e.currentTarget.checked)}
                    />
                    Internal note (never visible to the requester)
                  </label>
                  <div>
                    <Button type="submit" disabled={postingComment || commentBody.trim() === ""}>
                      {postingComment
                        ? "Posting…"
                        : commentInternal
                          ? "Add internal note"
                          : "Send reply"}
                    </Button>
                  </div>
                </form>
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
                      timestamp: new Date(ticket.createdAt).toLocaleString(),
                      dateTime: ticket.createdAt,
                      body: "Ticket created.",
                    },
                    {
                      id: "updated",
                      actor: "System",
                      timestamp: new Date(ticket.updatedAt).toLocaleString(),
                      dateTime: ticket.updatedAt,
                      body: "Ticket last updated.",
                    },
                  ]}
                />
              </div>
            ),
          },
        ]}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${ticket.subject}?`}
        description="The ticket moves to trash and can be restored."
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  )
}
