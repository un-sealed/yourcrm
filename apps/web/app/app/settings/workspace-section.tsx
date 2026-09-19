"use client"

import { useCallback, useEffect, useState } from "react"
import { Button, ErrorState, Field, Select, Skeleton, TextField } from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"
import type { WorkspaceSettings } from "./types"

/**
 * Workspace profile form (spec 40 §3: localization, branding).
 *
 * These fields live on the `workspaces` row, not in a parallel settings
 * table, so "the workspace" and "the workspace's settings" can never drift.
 * Validation is duplicated deliberately: HTML constraints for immediate
 * feedback, zod on the server for the decision.
 */

const CURRENCIES = ["USD", "EUR", "GBP", "INR", "AUD", "CAD", "SGD", "AED"]
const TIMEZONES = [
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Madrid",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Australia/Sydney",
]
const DATE_FORMATS = ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "D MMM YYYY"]

type FormState = {
  name: string
  timezone: string
  currency: string
  dateFormat: string
  logoUrl: string
  brandColor: string
  supportEmail: string
}

function toForm(settings: WorkspaceSettings): FormState {
  return {
    name: settings.name,
    timezone: settings.timezone,
    currency: settings.currency,
    dateFormat: settings.dateFormat,
    logoUrl: settings.logoUrl ?? "",
    brandColor: settings.brandColor ?? "",
    supportEmail: settings.supportEmail ?? "",
  }
}

export function WorkspaceSection() {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<WorkspaceSettings>("/api/v1/settings/workspace")
      setSettings(data)
      setForm(toForm(data))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the workspace profile.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const update = (patch: Partial<FormState>) => {
    setSaved(false)
    setForm((current) => (current === null ? current : { ...current, ...patch }))
  }

  const dirty =
    form !== null && settings !== null && JSON.stringify(form) !== JSON.stringify(toForm(settings))

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form) return
    setSaving(true)
    setError(null)
    try {
      const updated = await apiFetch<WorkspaceSettings>("/api/v1/settings/workspace", {
        method: "PATCH",
        body: {
          name: form.name,
          timezone: form.timezone,
          currency: form.currency,
          dateFormat: form.dateFormat,
          logoUrl: form.logoUrl.trim() === "" ? null : form.logoUrl.trim(),
          brandColor: form.brandColor.trim() === "" ? null : form.brandColor.trim(),
          supportEmail: form.supportEmail.trim() === "" ? null : form.supportEmail.trim(),
        },
      })
      setSettings(updated)
      setForm(toForm(updated))
      setSaved(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The workspace could not be saved.")
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading workspace profile">
        <Skeleton className="h-9 w-full max-w-md" />
        <Skeleton className="h-9 w-full max-w-md" />
        <Skeleton className="h-9 w-full max-w-md" />
      </div>
    )
  }

  if (error !== null && form === null) {
    return <ErrorState message={error} onRetry={() => void load()} />
  }

  if (form === null) return null

  return (
    <form className="flex max-w-2xl flex-col gap-4" onSubmit={save} noValidate>
      {error !== null ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
          Workspace settings saved.
        </p>
      ) : null}

      <Field label="Workspace name" htmlFor="workspace-name" required>
        <TextField
          id="workspace-name"
          value={form.name}
          maxLength={255}
          required
          onChange={(e) => update({ name: e.currentTarget.value })}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Timezone" htmlFor="workspace-timezone">
          <Select
            id="workspace-timezone"
            value={form.timezone}
            options={TIMEZONES.map((zone) => ({ value: zone, label: zone }))}
            onChange={(e) => update({ timezone: e.currentTarget.value })}
          />
        </Field>
        <Field label="Currency" htmlFor="workspace-currency">
          <Select
            id="workspace-currency"
            value={form.currency}
            options={CURRENCIES.map((code) => ({ value: code, label: code }))}
            onChange={(e) => update({ currency: e.currentTarget.value })}
          />
        </Field>
        <Field
          label="Date format"
          htmlFor="workspace-date-format"
          hint="How dates are displayed across the app."
        >
          <Select
            id="workspace-date-format"
            value={form.dateFormat}
            options={DATE_FORMATS.map((format) => ({ value: format, label: format }))}
            onChange={(e) => update({ dateFormat: e.currentTarget.value })}
          />
        </Field>
        <Field label="Brand colour" htmlFor="workspace-brand-color" hint="Hex value, e.g. #2563eb">
          <TextField
            id="workspace-brand-color"
            value={form.brandColor}
            placeholder="#2563eb"
            pattern="#[0-9a-fA-F]{6}"
            onChange={(e) => update({ brandColor: e.currentTarget.value })}
          />
        </Field>
      </div>

      <Field label="Logo URL" htmlFor="workspace-logo">
        <TextField
          id="workspace-logo"
          type="url"
          value={form.logoUrl}
          placeholder="https://example.com/logo.png"
          onChange={(e) => update({ logoUrl: e.currentTarget.value })}
        />
      </Field>

      <Field label="Support email" htmlFor="workspace-support-email">
        <TextField
          id="workspace-support-email"
          type="email"
          value={form.supportEmail}
          placeholder="support@example.com"
          onChange={(e) => update({ supportEmail: e.currentTarget.value })}
        />
      </Field>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!dirty || saving}
          onClick={() => settings !== null && setForm(toForm(settings))}
        >
          Discard
        </Button>
        {dirty ? (
          <span className="text-xs text-muted-foreground">You have unsaved changes.</span>
        ) : null}
      </div>
    </form>
  )
}
