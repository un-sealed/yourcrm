"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Skeleton,
  TextArea,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  describeAttribution,
  formatTimestamp,
  isChatBubble,
  toolOutcomeTone,
  type AiAskResponse,
  type AiConversation,
  type AiConversationDetail,
  type AiConversationsResponse,
  type AiMessage,
  type AiProviderStatus,
  type AiRun,
} from "./types"

/**
 * Ask Your CRM (spec 34-ai-assistant, P0).
 *
 * Chat over the workspace's own data. Three things this page must always
 * make visible, because they are product principles rather than polish:
 *
 *  1. **Which model answered** — every assistant turn carries a model,
 *     token count and latency line (§14, attribution).
 *  2. **What the assistant looked at** — tool calls are shown with their
 *     outcome and scope, so an answer is auditable by the person reading
 *     it (§3, tool-call transparency).
 *  3. **That it is read-only** — P0 cannot change anything, and says so.
 *
 * Answers arrive whole (no SSE in P0): the composer shows a pending turn
 * while the request is in flight, which keeps the UI honest about latency
 * without pretending to stream.
 */

const SUGGESTIONS = [
  "How many deals are in each stage?",
  "Which of my tasks are overdue?",
  "List the companies added this month",
]

export default function AiAssistantPage() {
  const [conversations, setConversations] = useState<AiConversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [detail, setDetail] = useState<AiConversationDetail | null>(null)
  const [provider, setProvider] = useState<AiProviderStatus | null>(null)
  const [draft, setDraft] = useState("")
  const [pending, setPending] = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [threadLoading, setThreadLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<AiConversation | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)

  const loadConversations = useCallback(async () => {
    setListLoading(true)
    setError(null)
    try {
      const res = await apiFetchRaw<AiConversationsResponse>("/api/v1/ai/conversations?limit=25")
      setConversations(res.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your conversations.")
    } finally {
      setListLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadConversations()
  }, [loadConversations])

  useEffect(() => {
    apiFetch<AiProviderStatus>("/api/v1/ai/provider")
      .then(setProvider)
      .catch(() => {
        // Attribution degrades to per-message model names; chat still works.
      })
  }, [])

  const openConversation = useCallback(async (id: string) => {
    setActiveId(id)
    setSidebarOpen(false)
    setThreadLoading(true)
    setSendError(null)
    try {
      setDetail(await apiFetch<AiConversationDetail>(`/api/v1/ai/conversations/${id}`))
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : "Could not open that conversation.")
    } finally {
      setThreadLoading(false)
    }
  }, [])

  const startNew = useCallback(() => {
    setActiveId(null)
    setDetail(null)
    setSendError(null)
    setSidebarOpen(false)
  }, [])

  const send = useCallback(
    async (text: string) => {
      const message = text.trim()
      if (message === "" || pending !== null) return
      setPending(message)
      setDraft("")
      setSendError(null)
      try {
        const answer = await apiFetch<AiAskResponse>("/api/v1/ai/chat", {
          method: "POST",
          body: { message, ...(activeId === null ? {} : { conversationId: activeId }) },
        })
        setActiveId(answer.conversation.id)
        setDetail((current) => {
          const base =
            current && current.conversation.id === answer.conversation.id
              ? current
              : { conversation: answer.conversation, messages: [], runs: [] }
          return {
            conversation: answer.conversation,
            messages: [...base.messages, answer.userMessage, answer.assistantMessage],
            runs: [...base.runs, answer.run],
          }
        })
        setConversations((current) =>
          current.some((row) => row.id === answer.conversation.id)
            ? current.map((row) => (row.id === answer.conversation.id ? answer.conversation : row))
            : [answer.conversation, ...current],
        )
      } catch (err) {
        setSendError(
          err instanceof ApiError
            ? err.message
            : "The assistant could not answer. Please try again.",
        )
        setDraft(message)
      } finally {
        setPending(null)
      }
    },
    [activeId, pending],
  )

  const remove = useCallback(async (conversation: AiConversation) => {
    try {
      await apiFetch(`/api/v1/ai/conversations/${conversation.id}`, { method: "DELETE" })
      setConversations((current) => current.filter((row) => row.id !== conversation.id))
      setActiveId((current) => (current === conversation.id ? null : current))
      setDetail((current) => (current?.conversation.id === conversation.id ? null : current))
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : "Could not delete that conversation.")
    } finally {
      setConfirmDelete(null)
    }
  }, [])

  const runsById = useMemo(() => {
    const map = new Map<string, AiRun>()
    for (const run of detail?.runs ?? []) map.set(run.id, run)
    return map
  }, [detail])

  const bubbles = useMemo(() => (detail?.messages ?? []).filter(isChatBubble), [detail])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" })
  }, [bubbles.length, pending])

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">AI Assistant</h1>
          <p className="text-sm text-muted-foreground">
            Ask about your CRM data. Answers only ever cover records you are allowed to see, and the
            assistant cannot change anything yet.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {provider ? (
            <Badge tone="info" title={`Provider: ${provider.providerId}`}>
              {provider.model}
            </Badge>
          ) : null}
          <Button
            variant="outline"
            onClick={() => setSidebarOpen((open) => !open)}
            className="md:hidden"
          >
            History
          </Button>
          <Button onClick={startNew}>New chat</Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-4">
        <aside
          className={`${sidebarOpen ? "block" : "hidden"} w-full shrink-0 md:block md:w-64`}
          aria-label="Conversation history"
        >
          {listLoading ? (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading history">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : error !== null ? (
            <ErrorState message={error} onRetry={() => void loadConversations()} />
          ) : conversations.length === 0 ? (
            <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              No conversations yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {conversations.map((conversation) => (
                <li key={conversation.id} className="group flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void openConversation(conversation.id)}
                    aria-current={conversation.id === activeId ? "true" : undefined}
                    className={`flex-1 truncate rounded-md px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      conversation.id === activeId ? "bg-accent font-medium" : ""
                    }`}
                    title={conversation.title}
                  >
                    {conversation.title}
                  </button>
                  <Button
                    variant="ghost"
                    aria-label={`Delete ${conversation.title}`}
                    onClick={() => setConfirmDelete(conversation)}
                  >
                    ×
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section
          className={`${sidebarOpen ? "hidden" : "flex"} min-h-0 flex-1 flex-col rounded-xl border border-border bg-card shadow-panel md:flex`}
          aria-label="Conversation"
        >
          <div className="flex-1 overflow-y-auto p-4">
            {threadLoading ? (
              <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading messages">
                <Skeleton className="h-16 w-2/3" />
                <Skeleton className="ml-auto h-16 w-2/3" />
              </div>
            ) : bubbles.length === 0 && pending === null ? (
              <EmptyState
                title="Ask your first question"
                description={
                  <div className="flex flex-col items-center gap-2">
                    <p>
                      The assistant reads your CRM through the reporting engine, with your own
                      permissions. Try one of these:
                    </p>
                    <div className="flex flex-wrap justify-center gap-2">
                      {SUGGESTIONS.map((suggestion) => (
                        <Button
                          key={suggestion}
                          variant="outline"
                          onClick={() => void send(suggestion)}
                        >
                          {suggestion}
                        </Button>
                      ))}
                    </div>
                  </div>
                }
              />
            ) : (
              <ol className="flex flex-col gap-4">
                {bubbles.map((message) => (
                  <AiBubble
                    key={message.id}
                    message={message}
                    run={message.runId === null ? undefined : runsById.get(message.runId)}
                    toolRows={(detail?.messages ?? []).filter(
                      (row) => row.role === "tool" && row.runId === message.runId,
                    )}
                  />
                ))}
                {pending !== null ? (
                  <li className="flex flex-col items-end gap-1">
                    <div className="max-w-[80%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
                      {pending}
                    </div>
                    <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
                      Thinking…
                    </p>
                  </li>
                ) : null}
              </ol>
            )}
            <div ref={endRef} />
          </div>

          <form
            className="border-t p-3"
            onSubmit={(event) => {
              event.preventDefault()
              void send(draft)
            }}
          >
            {sendError !== null ? (
              <p className="mb-2 text-sm text-destructive" role="alert">
                {sendError}
              </p>
            ) : null}
            <label htmlFor="ai-question" className="sr-only">
              Your question
            </label>
            <div className="flex items-end gap-2">
              <TextArea
                id="ai-question"
                rows={2}
                value={draft}
                placeholder="Ask about deals, people, tasks…"
                disabled={pending !== null}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault()
                    void send(draft)
                  }
                }}
              />
              <Button type="submit" disabled={pending !== null || draft.trim() === ""}>
                {pending !== null ? "Sending…" : "Send"}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Read-only in this release: the assistant can look things up, not change them.
            </p>
          </form>
        </section>
      </div>

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null)
        }}
        title="Delete conversation"
        description={`“${confirmDelete?.title ?? ""}” and its transcript will be removed.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (confirmDelete) void remove(confirmDelete)
        }}
      />
    </div>
  )
}

/** One chat turn: the text, who produced it, and what it looked at. */
function AiBubble({
  message,
  run,
  toolRows,
}: {
  message: AiMessage
  run: AiRun | undefined
  toolRows: AiMessage[]
}) {
  const mine = message.role === "user"
  const attribution = mine ? "" : describeAttribution(message, run)
  return (
    <li className={`flex flex-col gap-1 ${mine ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
          mine ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
        }`}
      >
        {message.content}
      </div>
      {!mine && toolRows.length > 0 ? (
        <ul className="flex flex-wrap gap-1" aria-label="Tool calls used for this answer">
          {toolRows.map((row) => {
            const summary = (row.toolCalls ?? {}) as { outcome?: string; summary?: string }
            const outcome = (summary.outcome ?? "succeeded") as "succeeded" | "failed" | "denied"
            return (
              <li key={row.id}>
                <Badge tone={toolOutcomeTone(outcome)}>
                  {row.toolName ?? "tool"}
                  {summary.summary === undefined ? "" : ` · ${summary.summary}`}
                </Badge>
              </li>
            )
          })}
        </ul>
      ) : null}
      {attribution !== "" ? (
        <p className="text-xs text-muted-foreground">
          {attribution}
          {message.createdAt ? ` · ${formatTimestamp(message.createdAt)}` : ""}
        </p>
      ) : null}
    </li>
  )
}
