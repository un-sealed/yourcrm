"use client"

import { useState } from "react"
import { Button, Field, Select, TextArea, TextField } from "@yourcrm/ui"
import { LEAD_SOURCES, LEAD_STATUSES, type Lead } from "./types"

export type LeadFormValues = {
  firstName: string
  lastName: string
  email: string
  phone: string
  companyName: string
  title: string
  source: string
  status: string
  score: string
  notes: string
}

export function leadToFormValues(lead: Lead): LeadFormValues {
  return {
    firstName: lead.firstName,
    lastName: lead.lastName ?? "",
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    companyName: lead.companyName ?? "",
    title: lead.title ?? "",
    source: lead.source,
    status: lead.status,
    score: String(lead.score),
    notes: lead.notes ?? "",
  }
}

export function emptyFormValues(): LeadFormValues {
  return {
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    companyName: "",
    title: "",
    source: "manual",
    status: "new",
    score: "0",
    notes: "",
  }
}

/** Serialize form state to the `POST/PATCH /api/v1/leads` body shape. */
export function formValuesToBody(values: LeadFormValues): Record<string, unknown> {
  const score = Number.parseInt(values.score, 10)
  return {
    firstName: values.firstName.trim(),
    ...(values.lastName.trim() === "" ? {} : { lastName: values.lastName.trim() }),
    ...(values.email.trim() === "" ? {} : { email: values.email.trim() }),
    ...(values.phone.trim() === "" ? {} : { phone: values.phone.trim() }),
    ...(values.companyName.trim() === "" ? {} : { companyName: values.companyName.trim() }),
    ...(values.title.trim() === "" ? {} : { title: values.title.trim() }),
    source: values.source,
    status: values.status,
    ...(Number.isNaN(score) ? {} : { score }),
    ...(values.notes.trim() === "" ? {} : { notes: values.notes.trim() }),
  }
}

type LeadFormProps = {
  initial?: LeadFormValues
  /** Hide the status row (creation always starts as `new`). */
  hideStatus?: boolean
  saving: boolean
  fieldError: string | null
  submitLabel: string
  onSubmit: (values: LeadFormValues) => void
  onCancel?: () => void
}

/** Shared create/edit form: required fields first, advanced fields collapsible. */
export function LeadForm({
  initial,
  hideStatus = false,
  saving,
  fieldError,
  submitLabel,
  onSubmit,
  onCancel,
}: LeadFormProps) {
  const [values, setValues] = useState<LeadFormValues>(() => initial ?? emptyFormValues())
  const set = (key: keyof LeadFormValues) => (e: { currentTarget: { value: string } }) =>
    setValues((prev) => ({ ...prev, [key]: e.currentTarget.value }))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit(values)
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" htmlFor="lead-first-name" required error={fieldError}>
          <TextField
            id="lead-first-name"
            value={values.firstName}
            onChange={set("firstName")}
            placeholder="Ada"
            required
          />
        </Field>
        <Field label="Last name" htmlFor="lead-last-name">
          <TextField
            id="lead-last-name"
            value={values.lastName}
            onChange={set("lastName")}
            placeholder="Lovelace"
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email" htmlFor="lead-email">
          <TextField
            id="lead-email"
            type="email"
            value={values.email}
            onChange={set("email")}
            placeholder="ada@example.com"
          />
        </Field>
        <Field label="Phone" htmlFor="lead-phone">
          <TextField
            id="lead-phone"
            type="tel"
            value={values.phone}
            onChange={set("phone")}
            placeholder="+1 555 0100"
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Company" htmlFor="lead-company">
          <TextField
            id="lead-company"
            value={values.companyName}
            onChange={set("companyName")}
            placeholder="Acme Inc"
          />
        </Field>
        <Field label="Job title" htmlFor="lead-title">
          <TextField
            id="lead-title"
            value={values.title}
            onChange={set("title")}
            placeholder="Engineer"
          />
        </Field>
      </div>
      <details className="rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
        <div className="mt-3 flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Source" htmlFor="lead-source">
              <Select
                id="lead-source"
                value={values.source}
                onChange={set("source")}
                options={LEAD_SOURCES.map((s) => ({ value: s, label: s }))}
              />
            </Field>
            {hideStatus ? null : (
              <Field label="Status" htmlFor="lead-status">
                <Select
                  id="lead-status"
                  value={values.status}
                  onChange={set("status")}
                  options={LEAD_STATUSES.map((s) => ({ value: s, label: s }))}
                />
              </Field>
            )}
          </div>
          <Field label="Score (0–100)" htmlFor="lead-score">
            <TextField
              id="lead-score"
              type="number"
              min={0}
              max={100}
              value={values.score}
              onChange={set("score")}
            />
          </Field>
          <Field label="Notes" htmlFor="lead-notes">
            <TextArea
              id="lead-notes"
              value={values.notes}
              onChange={set("notes")}
              placeholder="Context worth remembering…"
            />
          </Field>
        </div>
      </details>
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  )
}
