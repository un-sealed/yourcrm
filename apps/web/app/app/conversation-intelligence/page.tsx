"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Select,
  Skeleton,
  TextField,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  actionItemsOf,
  analysisStatusTone,
  analysisTypeLabel,
  describeAnalysisAttribution,
  describeAnalysisBounds,
  describeAnalysisRow,
  formatConversationTimestamp,
  highlightsOf,
  sentimentOf,
  sentimentTone,
  subjectTypeLabel,
  summaryTextOf,
  topicsOf,
  CONVERSATION_ANALYSIS_TYPES,
  type ConversationAnalysis,
  type ConversationAnalysisDetail,
  type ConversationAnalysesResponse,
  type ConversationAnalysisType,
  type ConversationIntelligenceStatus,
  type ConversationProposalResponse,
} from "./types"

/**
 * Conversation intelligence (spec 37, P0).
 *
 * Three things on one page: what has been analysed, what one analysis
 * says, and the conversation it says it about. The third is not
 * decoration — an AI reading of a private conversation is only reviewable
 * next to the conversation, and the page shows exactly how much of it the
 * model actually saw.
 *
 * Two product promises are enforced here rather than left to the copy:
 *
 *  - **Nothing is created behind your back.** Extracted action items
 *    render as a list with a "Propose as task" button. Pressing it opens
 *    an approval request; the task appears only after somebody approves
 *    it in the AI approval queue. The button says so.
 *  - **Sentiment always shows its caveat.** It is stored on the row and
 *    rendered every time, not hidden behind a tooltip.
 *
 * `components/nav-sections.ts` is shared and is not this module's file to
 * edit, so this route is reachable by URL but is not yet in the sidebar.
 */

const SUBJECT_TYPE_OPTIONS = [
  { value: "email_thread", label: "Email thread" },
  { value: "call", label: "Call" },
  { value: "whatsapp_conversation", label: "WhatsApp conversation" },
]

const STATUS_OPTIONS = [
  { value: "", label: "Any status" },
  { value: "succeeded", label: "Ready" },
  { value: "queued", label: "Waiting to run" },
  { value: "failed", label: "Failed" },
]

const TYPE_FILTER_OPTIONS = [
  { value: "", label: "Every kind" },
  ...CONVERSATION_ANALYSIS_TYPES.map((value) => ({ value, label: analysisTypeLabel(value) })),
]

type RequestForm = {
  subjectType: string
  subjectId: string
  types: ConversationAnalysisType[]
  queued: boolean
}

const EMPTY_FORM: RequestForm = {
  subjectType: "email_thread",
  subjectId: "",
  types: ["summary"],
  queued: false,
}

export default function ConversationIntelligencePage() {
  const [rows, setRows] = useState<ConversationAnalysis[]>([])
  const [status, setStatus] = useState<ConversationIntelligenceStatus | null>(null)
  const [statusFilter, setStatusFilter] = useState("")
  const [typeFilter, setTypeFilter] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ConversationAnalysisDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [requestOpen, setRequestOpen] = useState(false)
  const [form, setForm] = useState<RequestForm>(EMPTY_FORM)
  const [working, setWorking] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ limit: "25" })
      if (statusFilter !== "") qs.set("status", statusFilter)
      if (typeFilter !== "") qs.set("analysisType", typeFilter)
      const res = await apiFetchRaw<ConversationAnalysesResponse>(
        `/api/v1/conversation-intelligence/analyses?${qs.toString()}`,
      )
      setRows(res.data)
      setSelectedId((current) =>
        current !== null && res.data.some((row) => row.id === current)
          ? current
          : (res.data[0]?.id ?? null),
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load conversation intelligence.")
    } finally {
      setLoading(false)
    }
  }, [statusFilter, typeFilter])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    let cancelled = false
    void apiFetch<ConversationIntelligenceStatus>("/api/v1/conversation-intelligence/status")
      .then((value) => {
        if (!cancelled) setStatus(value)
      })
      .catch(() => {
        // A missing status panel must not break the page.
        if (!cancelled) setStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    void apiFetch<ConversationAnalysisDetail>(
      `/api/v1/conversation-intelligence/analyses/${selectedId}`,
    )
      .then((value) => {
        if (!cancelled) setDetail(value)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setDetail(null)
          setActionError(
            err instanceof ApiError && err.code === "NOT_FOUND"
              ? "That analysis is no longer available to you."
              : "Could not open that analysis.",
          )
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedId])

  const analysableSubjectTypes = useMemo(
    () =>
      SUBJECT_TYPE_OPTIONS.filter((option) =>
        status === null ? true : status.subjectTypes.includes(option.value),
      ),
    [status],
  )

  const toggleType = (type: ConversationAnalysisType) => {
    setForm((current) => ({
      ...current,
      types: current.types.includes(type)
        ? current.types.filter((value) => value !== type)
        : [...current.types, type],
    }))
  }

  const submitRequest = async () => {
    if (form.subjectId.trim() === "") {
      setActionError("Paste the id of the conversation you want analysed.")
      return
    }
    if (form.types.length === 0) {
      setActionError("Pick at least one kind of analysis.")
      return
    }
    setWorking(true)
    setActionError(null)
    try {
      const path = form.queued
        ? "/api/v1/conversation-intelligence/analyses/queue"
        : "/api/v1/conversation-intelligence/analyses"
      const created = await apiFetch<ConversationAnalysis[]>(path, {
        method: "POST",
        body: {
          subjectType: form.subjectType,
          subjectId: form.subjectId.trim(),
          types: form.types,
        },
      })
      setRequestOpen(false)
      setForm(EMPTY_FORM)
      setNotice(
        form.queued
          ? "Queued. The analyses will appear here when the worker has run them."
          : `Analysed. ${String(created.length)} result${created.length === 1 ? "" : "s"} added.`,
      )
      setSelectedId(created[0]?.id ?? null)
      await load()
    } catch (err) {
      setActionError(
        err instanceof ApiError
          ? err.code === "NOT_FOUND"
            ? "No conversation with that id that you can read."
            : err.message
          : "Could not run the analysis.",
      )
    } finally {
      setWorking(false)
    }
  }

  const proposeItem = async (analysisId: string, itemIndex: number) => {
    setWorking(true)
    setActionError(null)
    setNotice(null)
    try {
      const outcome = await apiFetch<ConversationProposalResponse>(
        `/api/v1/conversation-intelligence/analyses/${analysisId}/action-items/propose`,
        { method: "POST", body: { itemIndex } },
      )
      setNotice(
        outcome.request.status === "pending"
          ? "Proposed. It is waiting for approval in the AI approval queue — nothing has been created yet."
          : `The approval queue recorded it as ${outcome.request.status}.`,
      )
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not propose that action item.")
    } finally {
      setWorking(false)
    }
  }

  const selected = detail

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Conversation intelligence</h1>
          <p className="text-sm text-muted-foreground">
            Summaries, sentiment, action items and topics for conversations you can already read.
            Nothing here changes a record on its own.
          </p>
        </div>
        <Button onClick={() => setRequestOpen(true)}>Analyse a conversation</Button>
      </header>

      {status !== null ? (
        <p className="text-xs text-muted-foreground">
          {status.model} · up to {status.maxSourceChars.toLocaleString("en-GB")} characters per
          analysis · {status.queued ? "background analysis available" : "on-demand only"}
        </p>
      ) : null}

      {notice !== null ? (
        <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm text-foreground">
          {notice}
        </p>
      ) : null}
      {actionError !== null ? (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      <div className="flex flex-col gap-4 md:flex-row">
        <aside className="flex w-full flex-col gap-2 md:w-80">
          <div className="flex gap-2">
            <Select
              aria-label="Filter by status"
              value={statusFilter}
              options={STATUS_OPTIONS}
              onChange={(event) => setStatusFilter(event.target.value)}
            />
            <Select
              aria-label="Filter by kind of analysis"
              value={typeFilter}
              options={TYPE_FILTER_OPTIONS}
              onChange={(event) => setTypeFilter(event.target.value)}
            />
          </div>

          {loading ? (
            <div aria-busy="true" className="flex flex-col gap-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : error !== null ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No analyses yet"
              description="Pick a conversation you can read and ask for a summary, a sentiment read, its action items or its key topics."
              action={<Button onClick={() => setRequestOpen(true)}>Analyse a conversation</Button>}
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(row.id)}
                    aria-current={row.id === selectedId}
                    className="flex w-full flex-col gap-1 rounded-md border border-border p-3 text-left hover:bg-muted aria-[current=true]:border-primary"
                  >
                    <span className="flex items-center gap-2">
                      <Badge tone={analysisStatusTone(row.status)}>{row.status}</Badge>
                      <span className="text-sm font-medium">
                        {analysisTypeLabel(row.analysisType)}
                      </span>
                    </span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">
                      {describeAnalysisRow(row)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {subjectTypeLabel(row.subjectType)} ·{" "}
                      {formatConversationTimestamp(row.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="flex-1">
          {detailLoading ? (
            <div aria-busy="true" className="flex flex-col gap-3">
              <Skeleton className="h-8 w-2/3" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : selected === null ? (
            <EmptyState
              title="Nothing selected"
              description="Choose an analysis to see what it found and the conversation it read."
            />
          ) : (
            <AnalysisDetail
              detail={selected}
              working={working}
              onPropose={(index) => void proposeItem(selected.analysis.id, index)}
            />
          )}
        </section>
      </div>

      <Dialog
        open={requestOpen}
        onOpenChange={setRequestOpen}
        title="Analyse a conversation"
        description="You can only analyse a conversation you are allowed to read. The analysis inherits exactly that visibility."
      >
        <div className="flex flex-col gap-3">
          <Field label="Channel" htmlFor="ci-subject-type">
            <Select
              id="ci-subject-type"
              value={form.subjectType}
              options={analysableSubjectTypes}
              onChange={(event) => setForm({ ...form, subjectType: event.target.value })}
            />
          </Field>
          <Field
            label="Conversation id"
            htmlFor="ci-subject-id"
            hint="The id of the email thread or call, from its own page."
          >
            <TextField
              id="ci-subject-id"
              value={form.subjectId}
              onChange={(event) => setForm({ ...form, subjectId: event.target.value })}
            />
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">What to produce</legend>
            {CONVERSATION_ANALYSIS_TYPES.map((type) => (
              <label key={type} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={form.types.includes(type)}
                  onChange={() => toggleType(type)}
                  aria-label={analysisTypeLabel(type)}
                />
                {analysisTypeLabel(type)}
              </label>
            ))}
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.queued}
              onChange={() => setForm({ ...form, queued: !form.queued })}
              aria-label="Run in the background"
            />
            Run in the background instead of waiting
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRequestOpen(false)} disabled={working}>
              Cancel
            </Button>
            <Button onClick={() => void submitRequest()} disabled={working}>
              {working ? "Working…" : form.queued ? "Queue it" : "Analyse now"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}

function AnalysisDetail({
  detail,
  working,
  onPropose,
}: {
  detail: ConversationAnalysisDetail
  working: boolean
  onPropose: (itemIndex: number) => void
}) {
  const { analysis, subject } = detail
  const sentiment = sentimentOf(analysis.output)
  const items = actionItemsOf(analysis.output)
  const topics = topicsOf(analysis.output)
  const highlights = highlightsOf(analysis.output)
  const summary = summaryTextOf(analysis.output)

  return (
    <article className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">{analysisTypeLabel(analysis.analysisType)}</h2>
          <Badge tone={analysisStatusTone(analysis.status)}>{analysis.status}</Badge>
          <Badge tone="info">{subjectTypeLabel(analysis.subjectType)}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">{describeAnalysisAttribution(analysis)}</p>
        <p className="text-xs text-muted-foreground">{describeAnalysisBounds(analysis)}</p>
      </header>

      {analysis.status === "failed" ? (
        <ErrorState
          message={`This analysis failed (${analysis.errorCode ?? "unknown"}). Nothing was changed. You can ask for it again.`}
        />
      ) : null}

      {summary !== "" ? (
        <section className="flex flex-col gap-2">
          <p className="text-sm text-foreground">{summary}</p>
          {highlights.length > 0 ? (
            <ul className="list-disc pl-5 text-sm text-muted-foreground">
              {highlights.map((highlight) => (
                <li key={highlight}>{highlight}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {sentiment !== null ? (
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Badge tone={sentimentTone(sentiment.label)}>{sentiment.label}</Badge>
            {sentiment.score !== null ? (
              <span className="text-xs text-muted-foreground">score {sentiment.score}</span>
            ) : null}
          </div>
          {sentiment.rationale !== "" ? (
            <p className="text-sm text-foreground">{sentiment.rationale}</p>
          ) : null}
          {/* Always shown. The product promises a transparent caveat. */}
          {sentiment.caveat !== "" ? (
            <p className="text-xs text-muted-foreground">{sentiment.caveat}</p>
          ) : null}
        </section>
      ) : null}

      {analysis.analysisType === "action_items" ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Action items</h3>
          <p className="text-xs text-muted-foreground">
            These are suggestions, not tasks. Proposing one sends it to the AI approval queue;
            nothing is created until somebody approves it.
          </p>
          {items.length === 0 ? (
            <EmptyState
              title="No commitments found"
              description="The model did not find anything somebody promised to do."
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((item, index) => (
                <li
                  key={`${item.title}-${String(index)}`}
                  className="flex items-start justify-between gap-3 rounded-md border border-border p-3"
                >
                  <div className="flex flex-col">
                    <span className="text-sm text-foreground">{item.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {item.owner ?? "No owner named"}
                      {item.dueDate === null ? "" : ` · due ${item.dueDate}`}
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    disabled={working}
                    onClick={() => onPropose(index)}
                    aria-label={`Propose "${item.title}" as a task for approval`}
                  >
                    Propose as task
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {topics.length > 0 ? (
        <section className="flex flex-wrap gap-2">
          {topics.map((topic) => (
            <Badge key={topic.topic} tone="info">
              {topic.topic}
              {topic.mentions === null ? "" : ` (${String(topic.mentions)})`}
            </Badge>
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">The conversation this read</h3>
        {subject === null ? (
          <EmptyState
            title="Conversation unavailable"
            description="You can no longer read the conversation this analysis describes."
          />
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {subject.title} · {subject.participants.join(", ")} ·{" "}
              {formatConversationTimestamp(subject.occurredAt)}
            </p>
            <ol className="flex flex-col gap-2">
              {subject.turns.map((turn, index) => (
                <li
                  key={`${turn.speaker}-${String(index)}`}
                  className="rounded-md border border-border p-3"
                >
                  <p className="text-xs font-medium text-muted-foreground">
                    {turn.speaker}
                    {turn.at === null
                      ? ""
                      : ` · ${formatConversationTimestamp(turn.at) || turn.at}`}
                  </p>
                  <p className="whitespace-pre-wrap text-sm text-foreground">{turn.text}</p>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>
    </article>
  )
}
