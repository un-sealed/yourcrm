"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button, Field, Select, TextArea, TextField, toast } from "@yourcrm/ui"
import { useUnsavedGuard } from "@/components/use-unsaved-guard"
import { ApiError, apiFetch } from "@/lib/api-client"
import type { QuoteDetail } from "../types"

type DraftLine = { description: string; quantity: string; unitAmount: string; productId: string }

const EMPTY_LINE: DraftLine = { description: "", quantity: "1", unitAmount: "0.00", productId: "" }

const DISCOUNT_OPTIONS = [
  { value: "none", label: "No discount" },
  { value: "percent", label: "Percent" },
  { value: "fixed", label: "Fixed amount" },
]

/**
 * Create-quote form: required fields first, line items inline, discount/tax
 * and terms collapsible. Totals are never entered here — they are always
 * computed server-side from the line items plus discount/tax on save (see
 * `computeTotals` in the quotes domain service), and the detail page shows
 * the server's numbers, never a client guess.
 */
export default function NewQuotePage() {
  const router = useRouter()
  const [number, setNumber] = useState("")
  const [currency, setCurrency] = useState("USD")
  const [expiresAt, setExpiresAt] = useState("")
  const [discountType, setDiscountType] = useState("none")
  const [discountInput, setDiscountInput] = useState("0")
  const [taxRateInput, setTaxRateInput] = useState("0")
  const [terms, setTerms] = useState("")
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
      setFieldError("Quote number is required.")
      return
    }
    const lineItems: {
      description: string
      productId?: string
      quantity: number
      unitAmountCents: number
    }[] = []
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
      lineItems.push({
        description: line.description.trim(),
        ...(line.productId.trim() === "" ? {} : { productId: line.productId.trim() }),
        quantity,
        unitAmountCents,
      })
    }
    const discountValue =
      discountType === "none" ? 0 : Math.round(Number.parseFloat(discountInput || "0") * 100)
    if (!Number.isInteger(discountValue) || discountValue < 0) {
      setFieldError("Discount must be zero or more.")
      return
    }
    const taxRateBps = Math.round(Number.parseFloat(taxRateInput || "0") * 100)
    if (!Number.isInteger(taxRateBps) || taxRateBps < 0) {
      setFieldError("Tax rate must be zero or more.")
      return
    }
    setFieldError(null)
    setSaving(true)
    try {
      const quote = await apiFetch<QuoteDetail>("/api/v1/quotes", {
        method: "POST",
        body: {
          number: number.trim(),
          ...(currency.trim() === "" ? {} : { currency: currency.trim().toUpperCase() }),
          ...(expiresAt.trim() === "" ? {} : { expiresAt: expiresAt.trim() }),
          discountType,
          discountValue,
          taxRateBps,
          ...(terms.trim() === "" ? {} : { terms: terms.trim() }),
          ...(notes.trim() === "" ? {} : { notes: notes.trim() }),
          lineItems,
        },
      })
      toast({ title: "Quote created", description: `${number.trim()} was added.` })
      router.push(`/app/quotes/${quote.id}`)
    } catch (err) {
      setFieldError(err instanceof ApiError ? err.message : "Could not create the quote.")
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">New quote</h1>
        <Link href="/app/quotes" className="text-sm text-muted-foreground hover:underline">
          Back to quotes
        </Link>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Quote number" htmlFor="quote-number" required error={fieldError}>
            <TextField
              id="quote-number"
              value={number}
              onChange={(e) => setNumber(e.currentTarget.value)}
              placeholder="Q-001"
              required
              invalid={fieldError !== null && number.trim() === ""}
            />
          </Field>
          <Field label="Currency" htmlFor="quote-currency">
            <TextField
              id="quote-currency"
              value={currency}
              onChange={(e) => setCurrency(e.currentTarget.value)}
              placeholder="USD"
              maxLength={3}
            />
          </Field>
        </div>
        <Field label="Expires" htmlFor="quote-expires-at">
          <TextField
            id="quote-expires-at"
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.currentTarget.value)}
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setLines((prev) => [...prev, { ...EMPTY_LINE }])}
            >
              Add line
            </Button>
          </div>
        </section>
        <details className="rounded-md border border-border p-3" open>
          <summary className="cursor-pointer text-sm font-medium">Discount &amp; tax</summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <Field label="Discount type" htmlFor="quote-discount-type">
              <Select
                id="quote-discount-type"
                value={discountType}
                onChange={(e) => setDiscountType(e.currentTarget.value)}
                options={DISCOUNT_OPTIONS}
              />
            </Field>
            <Field
              label={discountType === "fixed" ? "Discount amount" : "Discount %"}
              htmlFor="quote-discount-value"
            >
              <TextField
                id="quote-discount-value"
                value={discountInput}
                onChange={(e) => setDiscountInput(e.currentTarget.value)}
                placeholder="0"
                inputMode="decimal"
                disabled={discountType === "none"}
              />
            </Field>
            <Field label="Tax rate %" htmlFor="quote-tax-rate">
              <TextField
                id="quote-tax-rate"
                value={taxRateInput}
                onChange={(e) => setTaxRateInput(e.currentTarget.value)}
                placeholder="0"
                inputMode="decimal"
              />
            </Field>
          </div>
        </details>
        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
          <div className="mt-3 flex flex-col gap-4">
            <Field label="Terms" htmlFor="quote-terms">
              <TextArea
                id="quote-terms"
                value={terms}
                onChange={(e) => setTerms(e.currentTarget.value)}
                placeholder="Payment terms, validity…"
              />
            </Field>
            <Field label="Notes" htmlFor="quote-notes">
              <TextArea
                id="quote-notes"
                value={notes}
                onChange={(e) => setNotes(e.currentTarget.value)}
                placeholder="Internal notes…"
              />
            </Field>
          </div>
        </details>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => router.push("/app/quotes")}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Create quote"}
          </Button>
        </div>
      </form>
    </div>
  )
}
