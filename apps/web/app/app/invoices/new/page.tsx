"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button, Field, TextArea, TextField, toast } from "@yourcrm/ui"
import { useUnsavedGuard } from "@/components/use-unsaved-guard"
import { ApiError, apiFetch } from "@/lib/api-client"
import type { InvoiceDetail } from "../types"

type DraftLine = { description: string; quantity: string; unitAmount: string }

const EMPTY_LINE: DraftLine = { description: "", quantity: "1", unitAmount: "0.00" }

/** Create-invoice form: required fields first, line items inline, notes collapsible. */
export default function NewInvoicePage() {
  const router = useRouter()
  const [number, setNumber] = useState("")
  const [currency, setCurrency] = useState("USD")
  const [dueDate, setDueDate] = useState("")
  const [notes, setNotes] = useState("")
  const [lines, setLines] = useState<DraftLine[]>([{ ...EMPTY_LINE }])
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const dirty = number !== "" || notes !== "" || lines.some((l) => l.description !== "")
  useUnsavedGuard(dirty && !saving)

  const setLine = (index: number, patch: Partial<DraftLine>) => {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)))
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (number.trim() === "") {
      setFieldError("Invoice number is required.")
      return
    }
    const lineItems: { description: string; quantity: number; unitAmountCents: number }[] = []
    for (const line of lines) {
      if (line.description.trim() === "") continue
      const quantity = Number.parseInt(line.quantity, 10)
      const unitAmountCents = Math.round(Number.parseFloat(line.unitAmount) * 100)
      if (!Number.isInteger(quantity) || quantity < 1) {
        setFieldError("Line quantities must be positive whole numbers.")
        return
      }
      if (!Number.isInteger(unitAmountCents) || unitAmountCents < 0) {
        setFieldError("Line unit amounts must be zero or more (e.g. 25.00).")
        return
      }
      lineItems.push({ description: line.description.trim(), quantity, unitAmountCents })
    }
    setFieldError(null)
    setSaving(true)
    try {
      const invoice = await apiFetch<InvoiceDetail>("/api/v1/invoices", {
        method: "POST",
        body: {
          number: number.trim(),
          ...(currency.trim() === "" ? {} : { currency: currency.trim().toUpperCase() }),
          ...(dueDate.trim() === "" ? {} : { dueDate: dueDate.trim() }),
          ...(notes.trim() === "" ? {} : { notes: notes.trim() }),
          lineItems,
        },
      })
      toast({ title: "Invoice created", description: `${number.trim()} was added.` })
      router.push(`/app/invoices/${invoice.id}`)
    } catch (err) {
      setFieldError(err instanceof ApiError ? err.message : "Could not create the invoice.")
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">New invoice</h1>
        <Link href="/app/invoices" className="text-sm text-muted-foreground hover:underline">
          Back to invoices
        </Link>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Invoice number" htmlFor="invoice-number" required error={fieldError}>
            <TextField
              id="invoice-number"
              value={number}
              onChange={(e) => setNumber(e.currentTarget.value)}
              placeholder="INV-001"
              required
              invalid={fieldError !== null && number.trim() === ""}
            />
          </Field>
          <Field label="Currency" htmlFor="invoice-currency">
            <TextField
              id="invoice-currency"
              value={currency}
              onChange={(e) => setCurrency(e.currentTarget.value)}
              placeholder="USD"
              maxLength={3}
            />
          </Field>
        </div>
        <Field label="Due date" htmlFor="invoice-due-date">
          <TextField
            id="invoice-due-date"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.currentTarget.value)}
          />
        </Field>
        <section aria-label="Line items" className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Line items</h2>
          {lines.map((line, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_5rem_7rem_auto]">
              <TextField
                value={line.description}
                onChange={(e) => setLine(index, { description: e.currentTarget.value })}
                placeholder="Description"
                aria-label={`Line ${index + 1} description`}
              />
              <TextField
                value={line.quantity}
                onChange={(e) => setLine(index, { quantity: e.currentTarget.value })}
                placeholder="Qty"
                inputMode="numeric"
                aria-label={`Line ${index + 1} quantity`}
              />
              <TextField
                value={line.unitAmount}
                onChange={(e) => setLine(index, { unitAmount: e.currentTarget.value })}
                placeholder="0.00"
                inputMode="decimal"
                aria-label={`Line ${index + 1} unit amount`}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove line ${index + 1}`}
                onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                disabled={lines.length === 1}
              >
                ✕
              </Button>
            </div>
          ))}
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, { ...EMPTY_LINE }])}>
              Add line
            </Button>
          </div>
        </section>
        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
          <div className="mt-3 flex flex-col gap-4">
            <Field label="Notes" htmlFor="invoice-notes">
              <TextArea
                id="invoice-notes"
                value={notes}
                onChange={(e) => setNotes(e.currentTarget.value)}
                placeholder="Payment terms, tax notes…"
              />
            </Field>
          </div>
        </details>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => router.push("/app/invoices")}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Create invoice"}
          </Button>
        </div>
      </form>
    </div>
  )
}
