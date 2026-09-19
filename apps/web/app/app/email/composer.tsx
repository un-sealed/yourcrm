"use client"

import { useState } from "react"
import { Button, Field, TextArea, TextField, toast } from "@yourcrm/ui"
import { useUnsavedGuard } from "@/components/use-unsaved-guard"
import { ApiError, apiFetch } from "@/lib/api-client"
import { parseEmailRecipients, type EmailMessageDetailResponse } from "./types"

export type EmailComposerProps = {
  /** Append to this thread instead of resolving one from the headers. */
  threadId?: string
  /** Reply to this stored message: the server derives In-Reply-To. */
  replyToMessageId?: string
  defaultSubject?: string
  defaultTo?: string
  submitLabel?: string
  onSent?: (sent: EmailMessageDetailResponse) => void
  onCancel?: () => void
}

/**
 * Compose + send. Recipients first, then subject, then the body; advanced
 * fields (cc/bcc, record links) are collapsed until asked for.
 *
 * The composer sends PLAIN TEXT. Rich HTML composition is P1 — and shipping
 * it would mean rendering provider HTML back, which this module
 * deliberately does not do (see `types.ts`).
 */
export function EmailComposer({
  threadId,
  replyToMessageId,
  defaultSubject = "",
  defaultTo = "",
  submitLabel = "Send",
  onSent,
  onCancel,
}: EmailComposerProps) {
  const [to, setTo] = useState(defaultTo)
  const [cc, setCc] = useState("")
  const [bcc, setBcc] = useState("")
  const [subject, setSubject] = useState(defaultSubject)
  const [body, setBody] = useState("")
  const [personId, setPersonId] = useState("")
  const [dealId, setDealId] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const dirty = to !== defaultTo || subject !== defaultSubject || body !== "" || cc !== ""
  useUnsavedGuard(dirty && !sending)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const recipients = parseEmailRecipients(to)
    if (recipients.invalid.length > 0) {
      setError(`Not a valid email address: ${recipients.invalid.join(", ")}`)
      return
    }
    if (recipients.valid.length === 0) {
      setError("Add at least one recipient.")
      return
    }
    if (body.trim() === "") {
      setError("Write a message before sending.")
      return
    }
    const ccList = parseEmailRecipients(cc)
    const bccList = parseEmailRecipients(bcc)
    if (ccList.invalid.length > 0 || bccList.invalid.length > 0) {
      setError(`Not a valid email address: ${[...ccList.invalid, ...bccList.invalid].join(", ")}`)
      return
    }

    setError(null)
    setSending(true)
    try {
      const sent = await apiFetch<EmailMessageDetailResponse>("/api/v1/email/messages", {
        method: "POST",
        body: {
          ...(threadId === undefined ? {} : { threadId }),
          ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
          subject: subject.trim(),
          to: recipients.valid,
          ...(ccList.valid.length === 0 ? {} : { cc: ccList.valid }),
          ...(bccList.valid.length === 0 ? {} : { bcc: bccList.valid }),
          bodyText: body,
          ...(personId.trim() === "" ? {} : { personId: personId.trim() }),
          ...(dealId.trim() === "" ? {} : { dealId: dealId.trim() }),
        },
      })
      toast({ title: "Email sent", description: `To ${recipients.valid[0]?.address ?? ""}` })
      setBody("")
      setCc("")
      setBcc("")
      onSent?.(sent)
    } catch (err) {
      // A 403 here means the caller lacks `send_external`; a 422 means no
      // email integration is connected. Both are actionable, so both are
      // shown verbatim — the API already redacted provider detail.
      setError(err instanceof ApiError ? err.message : "Could not send the email.")
    } finally {
      setSending(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Compose email">
      <Field label="To" htmlFor="email-to" required error={error} hint="Comma separated">
        <TextField
          id="email-to"
          value={to}
          onChange={(e) => setTo(e.currentTarget.value)}
          placeholder="ada@example.com"
          autoComplete="off"
          required
        />
      </Field>
      <Field label="Subject" htmlFor="email-subject">
        <TextField
          id="email-subject"
          value={subject}
          onChange={(e) => setSubject(e.currentTarget.value)}
          placeholder="Q3 budget"
        />
      </Field>
      <Field label="Message" htmlFor="email-body" required>
        <TextArea
          id="email-body"
          value={body}
          onChange={(e) => setBody(e.currentTarget.value)}
          placeholder="Write your message…"
          rows={10}
          required
        />
      </Field>
      <details className="rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Cc, Bcc and record links</summary>
        <div className="mt-3 flex flex-col gap-4">
          <Field label="Cc" htmlFor="email-cc">
            <TextField
              id="email-cc"
              value={cc}
              onChange={(e) => setCc(e.currentTarget.value)}
              autoComplete="off"
            />
          </Field>
          <Field label="Bcc" htmlFor="email-bcc">
            <TextField
              id="email-bcc"
              value={bcc}
              onChange={(e) => setBcc(e.currentTarget.value)}
              autoComplete="off"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Link to person" htmlFor="email-person">
              <TextField
                id="email-person"
                value={personId}
                onChange={(e) => setPersonId(e.currentTarget.value)}
                placeholder="Person id"
              />
            </Field>
            <Field label="Link to deal" htmlFor="email-deal">
              <TextField
                id="email-deal"
                value={dealId}
                onChange={(e) => setDealId(e.currentTarget.value)}
                placeholder="Deal id"
              />
            </Field>
          </div>
        </div>
      </details>
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={sending}>
          {sending ? "Sending…" : submitLabel}
        </Button>
      </div>
    </form>
  )
}
