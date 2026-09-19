"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
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
  DEAL_STAGES,
  formatMoney,
  stageLabel,
  weightedValue,
  type Deal,
} from "../_components/deals-lib"

const OPEN_STAGES = DEAL_STAGES.filter((s) => s !== "won" && s !== "lost")

/** Deal detail: header, tabbed overview/timeline, inline edit, stage moves. */
export default function DealDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id
  const [deal, setDeal] = useState<Deal | null>(null)
  const [tab, setTab] = useState("overview")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [amount, setAmount] = useState("")
  const [currency, setCurrency] = useState("USD")
  const [probability, setProbability] = useState("")
  const [closeDate, setCloseDate] = useState("")
  const [notes, setNotes] = useState("")
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [closeOpen, setCloseOpen] = useState<"won" | "lost" | null>(null)
  const [closeReason, setCloseReason] = useState("")
  const [closing, setClosing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<Deal>(`/api/v1/deals/${id}`)
      setDeal(data)
      setName(data.name)
      setAmount(data.amount === null || data.amount === undefined ? "" : String(data.amount))
      setCurrency(data.currency)
      setProbability(
        data.probability === null || data.probability === undefined ? "" : String(data.probability),
      )
      setCloseDate(data.expectedCloseDate ?? "")
      setNotes(data.notes ?? "")
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this deal.")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (name.trim() === "") {
      toast({ title: "Update failed", description: "Deal name is required." })
      return
    }
    const parsedAmount = amount.trim() === "" ? null : Number(amount)
    if (parsedAmount !== null && (!Number.isFinite(parsedAmount) || parsedAmount < 0)) {
      toast({ title: "Update failed", description: "Amount must be zero or more." })
      return
    }
    const parsedProbability = probability.trim() === "" ? null : Number(probability)
    if (
      parsedProbability !== null &&
      (!Number.isInteger(parsedProbability) || parsedProbability < 0 || parsedProbability > 100)
    ) {
      toast({ title: "Update failed", description: "Probability must be 0–100." })
      return
    }
    setSaving(true)
    try {
      const updated = await apiFetch<Deal>(`/api/v1/deals/${id}`, {
        method: "PATCH",
        body: {
          name: name.trim(),
          amount: parsedAmount,
          currency: currency.trim() === "" ? null : currency.trim(),
          probability: parsedProbability,
          expectedCloseDate: closeDate.trim() === "" ? null : closeDate.trim(),
          notes: notes.trim() === "" ? null : notes.trim(),
        },
      })
      setDeal(updated)
      toast({ title: "Deal updated" })
    } catch (err) {
      toast({
        title: "Update failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setSaving(false)
    }
  }

  const moveStage = async (stage: string) => {
    try {
      const updated = await apiFetch<Deal>(`/api/v1/deals/${id}/stage`, {
        method: "POST",
        body: { stage },
      })
      setDeal(updated)
      toast({ title: "Deal moved", description: `Now in ${stageLabel(stage)}.` })
    } catch (err) {
      toast({
        title: "Move failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  const closeDeal = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!closeOpen) return
    setClosing(true)
    try {
      const updated = await apiFetch<Deal>(`/api/v1/deals/${id}/${closeOpen}`, {
        method: "POST",
        body: closeReason.trim() === "" ? {} : { closeReason: closeReason.trim() },
      })
      setDeal(updated)
      setCloseOpen(null)
      setCloseReason("")
      toast({ title: closeOpen === "won" ? "Deal won" : "Deal lost" })
    } catch (err) {
      toast({
        title: "Close failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setClosing(false)
    }
  }

  const remove = async () => {
    try {
      await apiFetch(`/api/v1/deals/${id}`, { method: "DELETE" })
      toast({ title: "Deal deleted", description: "It can be restored from trash." })
      router.push("/app/deals")
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading deal">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error !== null || deal === null) {
    return <ErrorState message={error ?? "This deal does not exist."} onRetry={() => void load()} />
  }

  const weighted = weightedValue(deal)
  const isClosed = deal.stage === "won" || deal.stage === "lost"

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/deals" className="text-sm text-muted-foreground hover:underline">
        ← Back to deals
      </Link>
      <RecordHeader
        title={deal.name}
        subtitle={`${formatMoney(deal.amount, deal.currency)}${deal.probability !== null && deal.probability !== undefined ? ` · ${deal.probability}%` : ""}`}
        status={{
          label: stageLabel(deal.stage),
          tone: deal.stage === "won" ? "success" : deal.stage === "lost" ? "destructive" : "info",
        }}
        owner={undefined}
        actions={
          <>
            {!isClosed ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setCloseReason("")
                    setCloseOpen("won")
                  }}
                >
                  Mark won
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setCloseReason("")
                    setCloseOpen("lost")
                  }}
                >
                  Mark lost
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
        ariaLabel="Deal sections"
        items={[
          {
            value: "overview",
            label: "Overview",
            content: (
              <div className="grid gap-6 py-4 lg:grid-cols-2">
                <div className="flex flex-col gap-6">
                  <section aria-label="Value and forecast" className="flex flex-col gap-3">
                    <h2 className="text-sm font-semibold">Value &amp; forecast</h2>
                    <dl className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <dt className="text-muted-foreground">Amount</dt>
                        <dd className="font-medium">{formatMoney(deal.amount, deal.currency)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Weighted value</dt>
                        <dd className="font-medium">
                          {weighted === null ? "—" : formatMoney(weighted, deal.currency)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Probability</dt>
                        <dd>
                          {deal.probability === null || deal.probability === undefined
                            ? "—"
                            : `${deal.probability}%`}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Expected close</dt>
                        <dd>{deal.expectedCloseDate ?? "—"}</dd>
                      </div>
                      {deal.closeReason ? (
                        <div className="col-span-2">
                          <dt className="text-muted-foreground">Close reason</dt>
                          <dd>{deal.closeReason}</dd>
                        </div>
                      ) : null}
                      {deal.notes ? (
                        <div className="col-span-2">
                          <dt className="text-muted-foreground">Notes</dt>
                          <dd className="whitespace-pre-wrap">{deal.notes}</dd>
                        </div>
                      ) : null}
                    </dl>
                  </section>
                  <section aria-label="Pipeline and stage" className="flex flex-col gap-3">
                    <h2 className="text-sm font-semibold">Pipeline &amp; stage</h2>
                    <dl className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <dt className="text-muted-foreground">Stage</dt>
                        <dd>
                          <Badge
                            tone={
                              deal.stage === "won"
                                ? "success"
                                : deal.stage === "lost"
                                  ? "destructive"
                                  : "secondary"
                            }
                          >
                            {stageLabel(deal.stage)}
                          </Badge>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Pipeline</dt>
                        <dd>{deal.pipelineId ?? "—"}</dd>
                      </div>
                    </dl>
                    <Field label="Move stage" htmlFor="deal-move-stage">
                      <Select
                        id="deal-move-stage"
                        value={deal.stage}
                        onChange={(e) => {
                          if (e.currentTarget.value !== deal.stage) {
                            void moveStage(e.currentTarget.value)
                          }
                        }}
                        options={DEAL_STAGES.map((s) => ({ value: s, label: stageLabel(s) }))}
                      />
                    </Field>
                  </section>
                  <section aria-label="Related records" className="flex flex-col gap-3">
                    <h2 className="text-sm font-semibold">Related</h2>
                    {deal.personId === null && deal.companyId === null ? (
                      <EmptyState
                        title="No related records"
                        description="Link a person or company when creating or editing this deal."
                      />
                    ) : (
                      <dl className="flex flex-col gap-2 text-sm">
                        {deal.personId ? (
                          <div className="flex items-center gap-2">
                            <dt className="w-20 shrink-0 text-muted-foreground">Person</dt>
                            <dd className="font-mono text-xs">{deal.personId}</dd>
                          </div>
                        ) : null}
                        {deal.companyId ? (
                          <div className="flex items-center gap-2">
                            <dt className="w-20 shrink-0 text-muted-foreground">Company</dt>
                            <dd className="font-mono text-xs">{deal.companyId}</dd>
                          </div>
                        ) : null}
                      </dl>
                    )}
                  </section>
                </div>
                <section aria-label="Edit deal">
                  <h2 className="mb-3 text-sm font-semibold">Edit</h2>
                  <form onSubmit={save} className="flex flex-col gap-3">
                    <Field label="Deal name" htmlFor="deal-name">
                      <TextField
                        id="deal-name"
                        value={name}
                        onChange={(e) => setName(e.currentTarget.value)}
                      />
                    </Field>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Amount" htmlFor="deal-amount">
                        <TextField
                          id="deal-amount"
                          type="number"
                          min="0"
                          step="0.01"
                          value={amount}
                          onChange={(e) => setAmount(e.currentTarget.value)}
                        />
                      </Field>
                      <Field label="Currency" htmlFor="deal-currency">
                        <TextField
                          id="deal-currency"
                          value={currency}
                          onChange={(e) => setCurrency(e.currentTarget.value)}
                          maxLength={3}
                        />
                      </Field>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Probability (%)" htmlFor="deal-probability">
                        <TextField
                          id="deal-probability"
                          type="number"
                          min="0"
                          max="100"
                          step="1"
                          value={probability}
                          onChange={(e) => setProbability(e.currentTarget.value)}
                        />
                      </Field>
                      <Field label="Expected close" htmlFor="deal-close-date">
                        <TextField
                          id="deal-close-date"
                          type="date"
                          value={closeDate}
                          onChange={(e) => setCloseDate(e.currentTarget.value)}
                        />
                      </Field>
                    </div>
                    <Field label="Stage" htmlFor="deal-stage">
                      <Select
                        id="deal-stage"
                        value={deal.stage}
                        onChange={(e) => {
                          if (e.currentTarget.value !== deal.stage) {
                            void moveStage(e.currentTarget.value)
                          }
                        }}
                        options={OPEN_STAGES.map((s) => ({ value: s, label: stageLabel(s) }))}
                      />
                    </Field>
                    <Field label="Notes" htmlFor="deal-notes">
                      <TextArea
                        id="deal-notes"
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
                      timestamp: new Date(deal.createdAt).toLocaleString(),
                      dateTime: deal.createdAt,
                      body: `Deal created in ${stageLabel(deal.stage)}.`,
                    },
                    {
                      id: "updated",
                      actor: "System",
                      timestamp: new Date(deal.updatedAt).toLocaleString(),
                      dateTime: deal.updatedAt,
                      body: "Deal last updated.",
                    },
                  ]}
                />
              </div>
            ),
          },
        ]}
      />

      <Dialog
        open={closeOpen !== null}
        onOpenChange={(open) => {
          if (!open) setCloseOpen(null)
        }}
        title={closeOpen === "won" ? "Mark deal as won" : "Mark deal as lost"}
        description="The stage changes and the team is notified through the domain event."
      >
        <form onSubmit={closeDeal} className="mt-4 flex flex-col gap-3">
          <Field label="Reason" htmlFor="deal-close-reason">
            <TextField
              id="deal-close-reason"
              value={closeReason}
              onChange={(e) => setCloseReason(e.currentTarget.value)}
              placeholder={closeOpen === "won" ? "Signed the contract" : "Chose a competitor"}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setCloseOpen(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={closing}>
              {closing ? "Saving…" : closeOpen === "won" ? "Mark won" : "Mark lost"}
            </Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${deal.name}?`}
        description="The deal moves to trash and can be restored."
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  )
}
