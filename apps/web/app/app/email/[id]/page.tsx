"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  RecordHeader,
  Skeleton,
  TextField,
  toast,
} from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"
import { EmailComposer } from "../composer"
import {
  emailRecipientsLine,
  emailSenderLabel,
  emailStatusTone,
  emailThreadTitle,
  formatEmailTimestamp,
  type EmailMessageDetailResponse,
  type EmailThreadDetailResponse,
} from "../types"

/**
 * Thread detail: every message in order, then a reply composer.
 *
 * Bodies are rendered as TEXT inside a `whitespace-pre-wrap` block. There is
 * no `dangerouslySetInnerHTML` anywhere in this module: the API returns a
 * text rendering that the server derived from the provider's HTML with
 * scripts, styles, iframes, event handlers and `javascript:` URLs already
 * stripped (`packages/crm/src/email/sanitize.ts`), and React escapes what is
 * left. Rich HTML display is P1 and needs a real sanitiser dependency.
 */
export default function EmailThreadDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id
  const [detail, setDetail] = useState<EmailThreadDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [personId, setPersonId] = useState("")
  const [companyId, setCompanyId] = useState("")
  const [dealId, setDealId] = useState("")
  const [saving, setSaving] = useState(false)
  const [replying, setReplying] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<EmailThreadDetailResponse>(`/api/v1/email/threads/${id}`)
      setDetail(data)
      setPersonId(data.thread.personId ?? "")
      setCompanyId(data.thread.companyId ?? "")
      setDealId(data.thread.dealId ?? "")
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this thread.")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const patchThread = async (body: Record<string, unknown>, successTitle: string) => {
    setSaving(true)
    try {
      await apiFetch(`/api/v1/email/threads/${id}`, { method: "PATCH", body })
      toast({ title: successTitle })
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

  const remove = async () => {
    try {
      await apiFetch(`/api/v1/email/threads/${id}`, { method: "DELETE" })
      toast({ title: "Thread deleted", description: "It can be restored from trash." })
      router.push("/app/email")
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading email thread">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  if (error !== null || detail === null) {
    return (
      <ErrorState message={error ?? "This thread does not exist."} onRetry={() => void load()} />
    )
  }

  const { thread, messages } = detail
  const lastMessage = messages[messages.length - 1]

  return (
    <div className="flex flex-col gap-4">
      <RecordHeader
        title={emailThreadTitle(thread)}
        subtitle={`${thread.messageCount} message${thread.messageCount === 1 ? "" : "s"} · last activity ${formatEmailTimestamp(thread.lastMessageAt)}`}
        status={{ label: thread.status, tone: thread.status === "open" ? "info" : "secondary" }}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => setReplying((open) => !open)}>
              {replying ? "Close reply" : "Reply"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() =>
                void patchThread(
                  { status: thread.status === "open" ? "archived" : "open" },
                  thread.status === "open" ? "Thread archived" : "Thread reopened",
                )
              }
            >
              {thread.status === "open" ? "Archive" : "Reopen"}
            </Button>
            <Button type="button" variant="destructive" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </div>
        }
      />

      <Link href="/app/email" className="text-sm text-muted-foreground hover:underline">
        ← Back to email
      </Link>

      <section aria-label="Messages" className="flex flex-col gap-3">
        {messages.length === 0 ? (
          <EmptyState
            title="No messages in this thread"
            description="Messages appear here as they are sent or received."
          />
        ) : (
          messages.map((item) => <EmailMessageCard key={item.message.id} detail={item} />)
        )}
      </section>

      {replying && lastMessage ? (
        <section
          aria-label="Reply"
          className="rounded-xl border border-border bg-card p-4 shadow-panel"
        >
          <h2 className="mb-3 text-sm font-semibold">Reply</h2>
          <EmailComposer
            threadId={thread.id}
            replyToMessageId={lastMessage.message.id}
            defaultSubject={
              emailThreadTitle(thread).startsWith("Re:")
                ? emailThreadTitle(thread)
                : `Re: ${emailThreadTitle(thread)}`
            }
            defaultTo={lastMessage.message.fromAddress ?? ""}
            submitLabel="Send reply"
            onCancel={() => setReplying(false)}
            onSent={() => {
              setReplying(false)
              void load()
            }}
          />
        </section>
      ) : null}

      <section
        aria-label="Linked records"
        className="rounded-xl border border-border bg-card p-4 shadow-panel"
      >
        <h2 className="mb-3 text-sm font-semibold">Linked records</h2>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void patchThread(
              {
                personId: personId.trim() === "" ? null : personId.trim(),
                companyId: companyId.trim() === "" ? null : companyId.trim(),
                dealId: dealId.trim() === "" ? null : dealId.trim(),
              },
              "Thread links updated",
            )
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Person" htmlFor="thread-person">
              <TextField
                id="thread-person"
                value={personId}
                onChange={(e) => setPersonId(e.currentTarget.value)}
                placeholder="Person id"
              />
            </Field>
            <Field label="Company" htmlFor="thread-company">
              <TextField
                id="thread-company"
                value={companyId}
                onChange={(e) => setCompanyId(e.currentTarget.value)}
                placeholder="Company id"
              />
            </Field>
            <Field label="Deal" htmlFor="thread-deal">
              <TextField
                id="thread-deal"
                value={dealId}
                onChange={(e) => setDealId(e.currentTarget.value)}
                placeholder="Deal id"
              />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "Saving…" : "Save links"}
            </Button>
          </div>
        </form>
      </section>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this thread?"
        description="The thread and its messages move to trash."
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  )
}

/** One message: headers, delivery status, attachments and the text body. */
function EmailMessageCard({ detail }: { detail: EmailMessageDetailResponse }) {
  const { message, participants, attachments } = detail
  const timestamp = message.sentAt ?? message.receivedAt ?? message.createdAt
  const toLine = emailRecipientsLine(participants, "to")
  const ccLine = emailRecipientsLine(participants, "cc")

  return (
    <article className="rounded-xl border border-border bg-card p-4 shadow-panel">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{emailSenderLabel(detail)}</p>
          {toLine !== "" ? (
            <p className="truncate text-xs text-muted-foreground">To: {toLine}</p>
          ) : null}
          {ccLine !== "" ? (
            <p className="truncate text-xs text-muted-foreground">Cc: {ccLine}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={message.direction === "inbound" ? "secondary" : "outline"}>
            {message.direction}
          </Badge>
          <Badge tone={emailStatusTone(message.status)}>{message.status}</Badge>
          <time className="text-xs text-muted-foreground" dateTime={timestamp}>
            {formatEmailTimestamp(timestamp)}
          </time>
        </div>
      </header>

      {message.lastError !== null ? (
        <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {message.lastError}
        </p>
      ) : null}

      {/* Plain text only — see the note at the top of this file. */}
      <p className="mt-3 whitespace-pre-wrap break-words text-sm">
        {message.bodyText ?? message.snippet ?? ""}
      </p>

      {attachments.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Attachments">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <Badge tone="outline">
                {attachment.fileName}
                {attachment.mimeType === null ? "" : ` · ${attachment.mimeType}`}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  )
}
