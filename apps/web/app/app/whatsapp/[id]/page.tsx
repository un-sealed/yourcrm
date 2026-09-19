"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Select,
  Skeleton,
  TextArea,
  toast,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  isWhatsAppSessionWindowOpen,
  type WhatsAppConversation,
  type WhatsAppMessage,
  type WhatsAppMessageListResponse,
  type WhatsAppTemplate,
  type WhatsAppTemplateListResponse,
} from "../types"

const STATUS_TONE: Record<
  WhatsAppMessage["status"],
  "secondary" | "info" | "success" | "destructive"
> = {
  queued: "secondary",
  sent: "info",
  delivered: "info",
  read: "success",
  failed: "destructive",
}

function formatTimestamp(value: string | null): string {
  if (!value) return ""
  try {
    return new Date(value).toLocaleString()
  } catch {
    return ""
  }
}

/** Never render inbound message text as HTML — this is a plain-text node, not dangerouslySetInnerHTML. */
function MessageBubble({ message }: { message: WhatsAppMessage }) {
  const outbound = message.direction === "outbound"
  return (
    <li className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
      <div
        className={`flex max-w-[80%] flex-col gap-1 rounded-lg px-3 py-2 text-sm ${
          outbound ? "bg-primary text-primary-foreground" : "border bg-background"
        }`}
      >
        {message.kind === "template" ? (
          <span className="text-xs opacity-75">Template message</span>
        ) : null}
        {message.body ? (
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
        ) : message.mediaContentType ? (
          <p className="italic opacity-75">
            {message.mediaContentType} attachment
            {message.mediaFileName ? ` — ${message.mediaFileName}` : ""}
          </p>
        ) : (
          <p className="italic opacity-75">No content</p>
        )}
        <div className="flex items-center justify-end gap-2 text-xs opacity-75">
          <span>{formatTimestamp(message.createdAt)}</span>
          {outbound ? <Badge tone={STATUS_TONE[message.status]}>{message.status}</Badge> : null}
        </div>
        {message.status === "failed" && message.error ? (
          <p className="text-xs text-destructive-foreground/90">Failed: {message.error}</p>
        ) : null}
      </div>
    </li>
  )
}

export default function WhatsAppThreadPage() {
  const params = useParams<{ id: string }>()
  const id = params.id

  const [conversation, setConversation] = useState<WhatsAppConversation | null>(null)
  const [messages, setMessages] = useState<WhatsAppMessage[]>([])
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [textBody, setTextBody] = useState("")
  const [templateId, setTemplateId] = useState("")
  const [variablesInput, setVariablesInput] = useState("")
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [conv, msgs] = await Promise.all([
        apiFetch<WhatsAppConversation>(`/api/v1/whatsapp/conversations/${id}`),
        apiFetchRaw<WhatsAppMessageListResponse>(
          `/api/v1/whatsapp/conversations/${id}/messages?limit=100&order=asc`,
        ),
      ])
      setConversation(conv)
      setMessages(msgs.data)
      const tmpls = await apiFetchRaw<WhatsAppTemplateListResponse>(
        `/api/v1/whatsapp/templates?connectionId=${encodeURIComponent(conv.connectionId)}`,
      )
      setTemplates(tmpls.data.filter((t) => t.status === "approved"))
      if (conv.unreadCount > 0) {
        void apiFetch(`/api/v1/whatsapp/conversations/${id}/read`, { method: "POST" }).catch(
          () => undefined,
        )
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this conversation.")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const windowOpen = useMemo(
    () => (conversation ? isWhatsAppSessionWindowOpen(conversation.lastInboundAt) : false),
    [conversation],
  )

  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null

  const sendText = async (e: React.FormEvent) => {
    e.preventDefault()
    if (textBody.trim() === "") return
    setSending(true)
    setSendError(null)
    try {
      const message = await apiFetch<WhatsAppMessage>(
        `/api/v1/whatsapp/conversations/${id}/messages`,
        { method: "POST", body: { kind: "text", body: textBody.trim() } },
      )
      setMessages((prev) => [...prev, message])
      setTextBody("")
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : "Could not send the message.")
    } finally {
      setSending(false)
    }
  }

  const sendTemplateMessage = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedTemplate) {
      setSendError("Choose a template first.")
      return
    }
    setSending(true)
    setSendError(null)
    try {
      const variables = variablesInput
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v !== "")
      const message = await apiFetch<WhatsAppMessage>(
        `/api/v1/whatsapp/conversations/${id}/messages`,
        { method: "POST", body: { kind: "template", templateId: selectedTemplate.id, variables } },
      )
      setMessages((prev) => [...prev, message])
      setTemplateId("")
      setVariablesInput("")
      toast({
        title: "Template sent",
        description: "This re-opens the 24h session window once the contact replies.",
      })
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : "Could not send the template.")
    } finally {
      setSending(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading conversation">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error !== null || conversation === null) {
    return (
      <ErrorState
        message={error ?? "This conversation does not exist."}
        onRetry={() => void load()}
      />
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <Link href="/app/whatsapp" className="text-sm text-muted-foreground hover:underline">
            ← Back to WhatsApp
          </Link>
          <h1 className="text-xl font-semibold">{conversation.contactPhone}</h1>
        </div>
        <Badge tone={conversation.status === "open" ? "success" : "secondary"}>
          {conversation.status}
        </Badge>
      </div>

      {messages.length === 0 ? (
        <EmptyState
          title="No messages yet"
          description="Messages you send or receive on this number will appear here."
        />
      ) : (
        <ul className="flex flex-col gap-3 rounded-lg border p-4" aria-label="Message thread">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
        </ul>
      )}

      <div className="rounded-lg border p-4">
        {windowOpen ? (
          <form onSubmit={sendText} className="flex flex-col gap-2">
            <label htmlFor="whatsapp-composer" className="text-sm font-medium">
              Message
            </label>
            <TextArea
              id="whatsapp-composer"
              value={textBody}
              onChange={(e) => setTextBody(e.currentTarget.value)}
              placeholder="Type a message…"
              rows={3}
            />
            {sendError ? <p className="text-sm text-destructive">{sendError}</p> : null}
            <div className="flex justify-end">
              <Button type="submit" disabled={sending || textBody.trim() === ""}>
                {sending ? "Sending…" : "Send"}
              </Button>
            </div>
          </form>
        ) : (
          <form onSubmit={sendTemplateMessage} className="flex flex-col gap-2">
            <p className="text-sm font-medium">24-hour session window closed</p>
            <p className="text-sm text-muted-foreground">
              It has been more than 24 hours since this contact last messaged you. WhatsApp only
              allows an approved template outside that window — free-form text is disabled until
              they reply again.
            </p>
            <label htmlFor="whatsapp-composer" className="sr-only">
              Free-form message (disabled)
            </label>
            <TextArea
              id="whatsapp-composer"
              value=""
              disabled
              placeholder="Free-form text is disabled outside the 24h session window"
              rows={2}
            />
            {templates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No approved templates yet for this connection —{" "}
                <code>POST /api/v1/whatsapp/templates</code> to register one.
              </p>
            ) : (
              <>
                <label htmlFor="whatsapp-template" className="text-sm font-medium">
                  Template
                </label>
                <Select
                  id="whatsapp-template"
                  value={templateId}
                  onChange={(e) => setTemplateId(e.currentTarget.value)}
                  placeholder="Choose an approved template…"
                  options={templates.map((t) => ({
                    value: t.id,
                    label: `${t.name} (${t.language})`,
                  }))}
                />
                {selectedTemplate ? (
                  <p className="text-sm text-muted-foreground">{selectedTemplate.bodyText}</p>
                ) : null}
                {selectedTemplate && selectedTemplate.variableCount > 0 ? (
                  <label htmlFor="whatsapp-template-vars" className="text-sm font-medium">
                    Variables (comma-separated, {selectedTemplate.variableCount} expected)
                  </label>
                ) : null}
                {selectedTemplate && selectedTemplate.variableCount > 0 ? (
                  <TextArea
                    id="whatsapp-template-vars"
                    value={variablesInput}
                    onChange={(e) => setVariablesInput(e.currentTarget.value)}
                    rows={1}
                    placeholder="A100, Jane"
                  />
                ) : null}
                {sendError ? <p className="text-sm text-destructive">{sendError}</p> : null}
                <div className="flex justify-end">
                  <Button type="submit" disabled={sending || !selectedTemplate}>
                    {sending ? "Sending…" : "Send template"}
                  </Button>
                </div>
              </>
            )}
          </form>
        )}
      </div>
    </div>
  )
}
