"use client"

import { useCallback, useEffect, useState } from "react"
import { Button, Checkbox, ErrorState, Field, Skeleton, TextField, toast } from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"
import {
  DEFAULT_CHANNEL_TOGGLES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  categoryLabel,
  resolveChannels,
  type NotificationChannel,
  type NotificationChannelToggles,
  type NotificationPreference,
} from "../../notifications/types"

/**
 * Notification preferences (spec 43-notifications §"Email notification
 * preferences" / "Per-event preferences" / "Quiet hours"). Enforcement
 * happens server-side at send time
 * (`packages/crm/src/notifications/service.ts` `create()`) — this page only
 * edits the preference row; it is not itself a security boundary.
 */
export default function NotificationPreferencesPage() {
  const [categories, setCategories] = useState<Record<string, NotificationChannelToggles>>({})
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(false)
  const [quietHoursStart, setQuietHoursStart] = useState("22:00")
  const [quietHoursEnd, setQuietHoursEnd] = useState("07:00")
  const [timezone, setTimezone] = useState("UTC")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const pref = await apiFetch<NotificationPreference | null>(
        "/api/v1/notifications/preferences",
      )
      const next: Record<string, NotificationChannelToggles> = {}
      for (const category of NOTIFICATION_CATEGORIES)
        next[category] = resolveChannels(pref, category)
      setCategories(next)
      if (pref) {
        setQuietHoursEnabled(pref.quietHoursEnabled)
        setQuietHoursStart(pref.quietHoursStart ?? "22:00")
        setQuietHoursEnd(pref.quietHoursEnd ?? "07:00")
        setTimezone(pref.timezone)
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load notification preferences.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggleChannel = (category: string, channel: NotificationChannel, value: boolean) => {
    setCategories((prev) => ({
      ...prev,
      [category]: { ...(prev[category] ?? DEFAULT_CHANNEL_TOGGLES), [channel]: value },
    }))
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      await apiFetch("/api/v1/notifications/preferences", {
        method: "PUT",
        body: {
          categories,
          quietHoursEnabled,
          quietHoursStart: quietHoursEnabled ? quietHoursStart : null,
          quietHoursEnd: quietHoursEnabled ? quietHoursEnd : null,
          timezone: timezone.trim() === "" ? "UTC" : timezone.trim(),
        },
      })
      toast({ title: "Notification preferences saved" })
    } catch (err) {
      toast({
        title: "Save failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div
        className="flex flex-col gap-4"
        aria-busy="true"
        aria-label="Loading notification preferences"
      >
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (error !== null) {
    return <ErrorState message={error} onRetry={() => void load()} />
  }

  return (
    <form onSubmit={save} className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Notification preferences</h1>
        <p className="text-sm text-muted-foreground">
          Choose which events notify you, and when to stay quiet. In-app is the only channel
          delivered today — email, push and SMS are saved but not sent yet.
        </p>
      </div>

      <section aria-label="Categories" className="flex flex-col gap-3">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 font-medium">Category</th>
              {NOTIFICATION_CHANNELS.map((channel) => (
                <th key={channel.key} className="py-2 text-center font-medium">
                  {channel.label}
                  {!channel.deliverable ? <span className="ml-1 font-normal">(soon)</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {NOTIFICATION_CATEGORIES.map((category) => {
              const toggles = categories[category] ?? DEFAULT_CHANNEL_TOGGLES
              return (
                <tr key={category} className="border-b last:border-0">
                  <td className="py-2">{categoryLabel(category)}</td>
                  {NOTIFICATION_CHANNELS.map((channel) => (
                    <td key={channel.key} className="py-2 text-center">
                      <Checkbox
                        aria-label={`${categoryLabel(category)} — ${channel.label}`}
                        checked={toggles[channel.key]}
                        disabled={!channel.deliverable}
                        onChange={(e) =>
                          toggleChannel(category, channel.key, e.currentTarget.checked)
                        }
                      />
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      <section aria-label="Quiet hours" className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-panel">
        <div className="flex items-center gap-2">
          <Checkbox
            id="quiet-hours-enabled"
            checked={quietHoursEnabled}
            onChange={(e) => setQuietHoursEnabled(e.currentTarget.checked)}
          />
          <label htmlFor="quiet-hours-enabled" className="text-sm font-medium">
            Enable quiet hours
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          No in-app notifications are created during this window, evaluated in your timezone below.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Starts" htmlFor="quiet-hours-start">
            <TextField
              id="quiet-hours-start"
              type="time"
              value={quietHoursStart}
              disabled={!quietHoursEnabled}
              onChange={(e) => setQuietHoursStart(e.currentTarget.value)}
            />
          </Field>
          <Field label="Ends" htmlFor="quiet-hours-end">
            <TextField
              id="quiet-hours-end"
              type="time"
              value={quietHoursEnd}
              disabled={!quietHoursEnabled}
              onChange={(e) => setQuietHoursEnd(e.currentTarget.value)}
            />
          </Field>
          <Field
            label="Timezone"
            htmlFor="quiet-hours-timezone"
            hint="IANA name, e.g. America/New_York"
          >
            <TextField
              id="quiet-hours-timezone"
              value={timezone}
              disabled={!quietHoursEnabled}
              onChange={(e) => setTimezone(e.currentTarget.value)}
            />
          </Field>
        </div>
      </section>

      <div>
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save preferences"}
        </Button>
      </div>
    </form>
  )
}
