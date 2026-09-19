"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  Button,
  ConfirmDialog,
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
import { formatMoney, statusTone, type QuoteDetail } from "../types"

/**
 * Quote detail: header, tabbed overview/timeline, inline edit, lifecycle
 * actions (send/accept/reject), delete. Totals shown here are always the
 * server's `totals` from the detail response — the page never computes or
 * edits them itself. PDF generation is explicitly out of scope (spec 19).
 */
export default function QuoteDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id
  const [quote, setQuote] = useState<QuoteDetail | null>(null)
  const [tab, setTab] = useState("overview")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [terms, setTerms] = useState("")
  const [notes, setNotes] = useState("")
  const [expiresAt, setExpiresAt] = useState("")
  const [saving, setSaving] = useState(false)
  const [transitioning, setTransitioning] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<QuoteDetail>(`/api/v1/quotes/${id}`)
      setQuote(data)
      setTerms(data.terms ?? "")
      setNotes(data.notes ?? "")
      setExpiresAt(data.expiresAt ?? "")
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this quote.")
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
      await apiFetch<QuoteDetail>(`/api/v1/quotes/${id}`, {
        method: "PATCH",
        body: {
          terms: terms.trim() === "" ? null : terms.trim(),
          notes: notes.trim() === "" ? null : notes.trim(),
          expiresAt: expiresAt.trim() === "" ? null : expiresAt.trim(),
        },
      })
      await load()
      toast({ title: "Quote updated" })
    } catch (err) {
      toast({
        title: "Update failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setSaving(false)
    }
  }

  const doTransition = async (action: "send" | "accept" | "reject") => {
    setTransitioning(true)
    try {
      await apiFetch<QuoteDetail>(`/api/v1/quotes/${id}/${action}`, { method: "POST" })
      await load()
      toast({ title: `Quote ${action === "send" ? "sent" : action + "ed"}` })
    } catch (err) {
      toast({
        title: "That transition isn't allowed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setTransitioning(false)
    }
  }

  const remove = async () => {
    try {
      await apiFetch(`/api/v1/quotes/${id}`, { method: "DELETE" })
      toast({ title: "Quote deleted", description: "It can be restored from trash." })
      router.push("/app/quotes")
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading quote">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error !== null || quote === null) {
    return (
      <ErrorState message={error ?? "This quote does not exist."} onRetry={() => void load()} />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/quotes" className="text-sm text-muted-foreground hover:underline">
        ← Back to quotes
      </Link>
      <RecordHeader
        title={quote.number}
        subtitle={`${formatMoney(quote.totals.grandTotalCents, quote.currency)} total`}
        status={{ label: quote.status, tone: statusTone(quote.status) }}
        owner={undefined}
        actions={
          <>
            {quote.status === "draft" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void doTransition("send")}
                disabled={transitioning}
              >
                {transitioning ? "Sending…" : "Send"}
              </Button>
            ) : null}
            {quote.status === "sent" ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void doTransition("accept")}
                  disabled={transitioning}
                >
                  Accept
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void doTransition("reject")}
                  disabled={transitioning}
                >
                  Reject
                </Button>
              </>
            ) : null}
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </>
        }
      />

      <Tabs
        value={tab}
        onValueChange={setTab}
        ariaLabel="Quote sections"
        items={[
          {
            value: "overview",
            label: "Overview",
            content: (
              <div className="grid gap-6 py-4 lg:grid-cols-2">
                <section aria-label="Amounts and line items" className="flex flex-col gap-3">
                  <h2 className="text-sm font-semibold">Amounts</h2>
                  <dl className="flex flex-col gap-2 text-sm">
                    <div className="flex items-center gap-2">
                      <dt className="w-24 shrink-0 text-muted-foreground">Subtotal</dt>
                      <dd>{formatMoney(quote.totals.subtotalCents, quote.currency)}</dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-24 shrink-0 text-muted-foreground">Discount</dt>
                      <dd>{formatMoney(quote.totals.discountCents, quote.currency)}</dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-24 shrink-0 text-muted-foreground">Tax</dt>
                      <dd>{formatMoney(quote.totals.taxCents, quote.currency)}</dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-24 shrink-0 text-muted-foreground">Grand total</dt>
                      <dd className="font-medium">
                        {formatMoney(quote.totals.grandTotalCents, quote.currency)}
                      </dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-24 shrink-0 text-muted-foreground">Expires</dt>
                      <dd>{quote.expiresAt ?? <span className="text-muted-foreground">—</span>}</dd>
                    </div>
                  </dl>
                  <h3 className="text-sm font-semibold">Line items</h3>
                  {quote.lineItems.length === 0 ? (
                    <EmptyState
                      title="No line items"
                      description="This quote has no line items yet."
                    />
                  ) : (
                    <ul className="flex flex-col gap-2 text-sm">
                      {quote.lineItems.map((item) => (
                        <li key={item.id} className="flex items-center justify-between gap-2">
                          <span>
                            {item.description}{" "}
                            <span className="text-muted-foreground">× {item.quantity}</span>
                          </span>
                          <span>
                            {formatMoney(item.quantity * item.unitAmountCents, quote.currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section aria-label="Edit quote">
                  <h2 className="mb-3 text-sm font-semibold">Edit</h2>
                  <form onSubmit={save} className="flex flex-col gap-3">
                    <Field label="Expires" htmlFor="quote-expires-at">
                      <TextField
                        id="quote-expires-at"
                        type="date"
                        value={expiresAt}
                        onChange={(e) => setExpiresAt(e.currentTarget.value)}
                      />
                    </Field>
                    <Field label="Terms" htmlFor="quote-terms">
                      <TextArea
                        id="quote-terms"
                        value={terms}
                        onChange={(e) => setTerms(e.currentTarget.value)}
                      />
                    </Field>
                    <Field label="Notes" htmlFor="quote-notes">
                      <TextArea
                        id="quote-notes"
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
                      timestamp: new Date(quote.createdAt).toLocaleString(),
                      dateTime: quote.createdAt,
                      body: `Quote ${quote.number} created.`,
                    },
                    {
                      id: "updated",
                      actor: "System",
                      timestamp: new Date(quote.updatedAt).toLocaleString(),
                      dateTime: quote.updatedAt,
                      body: "Quote last updated.",
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
        title={`Delete ${quote.number}?`}
        description="The quote moves to trash and can be restored."
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  )
}
