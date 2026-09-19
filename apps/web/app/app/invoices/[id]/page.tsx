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
  formatMoney,
  statusLabel,
  statusTone,
  type InvoiceDetail,
} from "../types"

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "paid", label: "Paid" },
  { value: "void", label: "Void" },
]

const METHOD_OPTIONS = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "upi", label: "UPI" },
  { value: "other", label: "Other" },
]

/** Invoice detail: header, tabbed overview/timeline, edit, send, payments, delete. */
export default function InvoiceDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null)
  const [tab, setTab] = useState("overview")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState("")
  const [dueDate, setDueDate] = useState("")
  const [status, setStatus] = useState("draft")
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [payAmount, setPayAmount] = useState("")
  const [payMethod, setPayMethod] = useState("other")
  const [paying, setPaying] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<InvoiceDetail>(`/api/v1/invoices/${id}`)
      setInvoice(data)
      setNotes(data.notes ?? "")
      setDueDate(data.dueDate ?? "")
      setStatus(data.status)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this invoice.")
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
      const updated = await apiFetch<InvoiceDetail>(`/api/v1/invoices/${id}`, {
        method: "PATCH",
        body: {
          notes: notes.trim() === "" ? null : notes.trim(),
          dueDate: dueDate.trim() === "" ? null : dueDate.trim(),
          status,
        },
      })
      // PATCH returns the scalar record; reload for the full detail + totals.
      setStatus(updated.status)
      await load()
      toast({ title: "Invoice updated" })
    } catch (err) {
      toast({
        title: "Update failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setSaving(false)
    }
  }

  const send = async () => {
    setSending(true)
    try {
      const updated = await apiFetch<InvoiceDetail>(`/api/v1/invoices/${id}/send`, {
        method: "POST",
      })
      setStatus(updated.status)
      await load()
      toast({ title: "Invoice sent" })
    } catch (err) {
      toast({
        title: "Send failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setSending(false)
    }
  }

  const recordPayment = async (e: React.FormEvent) => {
    e.preventDefault()
    const amountCents = Math.round(Number.parseFloat(payAmount) * 100)
    if (!Number.isInteger(amountCents) || amountCents < 1) {
      toast({ title: "Invalid amount", description: "Enter an amount greater than zero." })
      return
    }
    setPaying(true)
    try {
      await apiFetch(`/api/v1/invoices/${id}/payments`, {
        method: "POST",
        body: { amountCents, method: payMethod },
      })
      setPayAmount("")
      await load()
      toast({ title: "Payment recorded" })
    } catch (err) {
      toast({
        title: "Payment failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setPaying(false)
    }
  }

  const remove = async () => {
    try {
      await apiFetch(`/api/v1/invoices/${id}`, { method: "DELETE" })
      toast({ title: "Invoice deleted", description: "It can be restored from trash." })
      router.push("/app/invoices")
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading invoice">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error !== null || invoice === null) {
    return (
      <ErrorState message={error ?? "This invoice does not exist."} onRetry={() => void load()} />
    )
  }

  const label = statusLabel(invoice.status, invoice.totals.overdue)

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/invoices" className="text-sm text-muted-foreground hover:underline">
        ← Back to invoices
      </Link>
      <RecordHeader
        title={invoice.number}
        subtitle={`${formatMoney(invoice.totals.totalCents, invoice.currency)} · ${formatMoney(invoice.totals.balanceDueCents, invoice.currency)} due`}
        status={{ label, tone: statusTone(invoice.status, invoice.totals.overdue) }}
        owner={undefined}
        actions={
          <>
            {invoice.status === "draft" ? (
              <Button variant="outline" size="sm" onClick={() => void send()} disabled={sending}>
                {sending ? "Sending…" : "Send"}
              </Button>
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
        ariaLabel="Invoice sections"
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
                      <dt className="w-24 shrink-0 text-muted-foreground">Total</dt>
                      <dd>{formatMoney(invoice.totals.totalCents, invoice.currency)}</dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-24 shrink-0 text-muted-foreground">Paid</dt>
                      <dd>{formatMoney(invoice.totals.paidCents, invoice.currency)}</dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-24 shrink-0 text-muted-foreground">Balance due</dt>
                      <dd className="font-medium">
                        {formatMoney(invoice.totals.balanceDueCents, invoice.currency)}
                      </dd>
                      {invoice.totals.overdue ? <Badge tone="destructive">Overdue</Badge> : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-24 shrink-0 text-muted-foreground">Due date</dt>
                      <dd>{invoice.dueDate ?? <span className="text-muted-foreground">—</span>}</dd>
                    </div>
                  </dl>
                  <h3 className="text-sm font-semibold">Line items</h3>
                  {invoice.lineItems.length === 0 ? (
                    <EmptyState
                      title="No line items"
                      description="This invoice has no line items yet."
                    />
                  ) : (
                    <ul className="flex flex-col gap-2 text-sm">
                      {invoice.lineItems.map((item) => (
                        <li key={item.id} className="flex items-center justify-between gap-2">
                          <span>
                            {item.description}{" "}
                            <span className="text-muted-foreground">× {item.quantity}</span>
                          </span>
                          <span>
                            {formatMoney(item.quantity * item.unitAmountCents, invoice.currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <h3 className="text-sm font-semibold">Payments</h3>
                  {invoice.payments.length === 0 ? (
                    <EmptyState
                      title="No payments recorded"
                      description="Record a manual payment below when money arrives."
                    />
                  ) : (
                    <ul className="flex flex-col gap-2 text-sm">
                      {invoice.payments.map((payment) => (
                        <li key={payment.id} className="flex items-center justify-between gap-2">
                          <span>
                            {payment.method}
                            {payment.reference ? (
                              <span className="text-muted-foreground"> · {payment.reference}</span>
                            ) : null}
                          </span>
                          <span>{formatMoney(payment.amountCents, payment.currency)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {invoice.totals.balanceDueCents > 0 ? (
                    <form onSubmit={recordPayment} className="flex items-end gap-2">
                      <Field label="Amount" htmlFor="payment-amount">
                        <TextField
                          id="payment-amount"
                          value={payAmount}
                          onChange={(e) => setPayAmount(e.currentTarget.value)}
                          placeholder="0.00"
                          inputMode="decimal"
                        />
                      </Field>
                      <Field label="Method" htmlFor="payment-method">
                        <Select
                          id="payment-method"
                          value={payMethod}
                          onChange={(e) => setPayMethod(e.currentTarget.value)}
                          options={METHOD_OPTIONS}
                        />
                      </Field>
                      <Button type="submit" disabled={paying}>
                        {paying ? "Saving…" : "Record payment"}
                      </Button>
                    </form>
                  ) : null}
                </section>
                <section aria-label="Edit invoice">
                  <h2 className="mb-3 text-sm font-semibold">Edit</h2>
                  <form onSubmit={save} className="flex flex-col gap-3">
                    <Field label="Due date" htmlFor="invoice-due-date">
                      <TextField
                        id="invoice-due-date"
                        type="date"
                        value={dueDate}
                        onChange={(e) => setDueDate(e.currentTarget.value)}
                      />
                    </Field>
                    <Field label="Status" htmlFor="invoice-status">
                      <Select
                        id="invoice-status"
                        value={status}
                        onChange={(e) => setStatus(e.currentTarget.value)}
                        options={STATUS_OPTIONS}
                      />
                    </Field>
                    <Field label="Notes" htmlFor="invoice-notes">
                      <TextArea
                        id="invoice-notes"
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
                      timestamp: new Date(invoice.createdAt).toLocaleString(),
                      dateTime: invoice.createdAt,
                      body: `Invoice ${invoice.number} created.`,
                    },
                    {
                      id: "updated",
                      actor: "System",
                      timestamp: new Date(invoice.updatedAt).toLocaleString(),
                      dateTime: invoice.updatedAt,
                      body: "Invoice last updated.",
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
        title={`Delete ${invoice.number}?`}
        description="The invoice moves to trash and can be restored."
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  )
}
