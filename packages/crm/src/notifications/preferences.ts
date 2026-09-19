import { toWorkspaceLocalParts } from "../calendar/timezone"
import {
  DEFAULT_CHANNEL_TOGGLES,
  type NotificationChannel,
  type NotificationChannelToggles,
} from "./schemas"
import type { NotificationPreferenceRecord } from "./types"

/**
 * Suppression policy (spec 43 §"Preference and quiet-hours enforcement
 * happens server-side at send time"). Pure functions, unit-tested directly
 * — no store/service wiring needed to prove the rule.
 */

export type EffectivePreference = {
  categories: Record<string, Partial<NotificationChannelToggles>>
  quietHoursEnabled: boolean
  quietHoursStart: string | null
  quietHoursEnd: string | null
  timezone: string
}

/** No preference row exists yet: every category defaults to in-app only, quiet hours off. */
export function defaultPreference(): EffectivePreference {
  return {
    categories: {},
    quietHoursEnabled: false,
    quietHoursStart: null,
    quietHoursEnd: null,
    timezone: "UTC",
  }
}

export function toEffectivePreference(
  row: NotificationPreferenceRecord | null,
): EffectivePreference {
  if (!row) return defaultPreference()
  return {
    categories: row.categories ?? {},
    quietHoursEnabled: row.quietHoursEnabled,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
    timezone: row.timezone || "UTC",
  }
}

/** Effective channel toggles for one category — an unlisted category (or unlisted channel) uses the default. */
export function resolveChannels(
  pref: EffectivePreference,
  category: string,
): NotificationChannelToggles {
  const override = pref.categories[category]
  if (!override) return DEFAULT_CHANNEL_TOGGLES
  return { ...DEFAULT_CHANNEL_TOGGLES, ...override }
}

export function isChannelEnabled(
  pref: EffectivePreference,
  category: string,
  channel: NotificationChannel,
): boolean {
  return resolveChannels(pref, category)[channel]
}

function toMinutes(hhmm: string): number {
  const [h = "0", m = "0"] = hhmm.split(":")
  return Number(h) * 60 + Number(m)
}

/**
 * Whether `nowIso` falls inside the user's quiet-hours window, evaluated in
 * their preference timezone (never the workspace timezone — quiet hours are
 * a personal setting). Handles overnight windows (e.g. 22:00 -> 07:00) via
 * wraparound. An equal start/end is treated as "no window" rather than "all
 * day", so a misconfigured pair never silently suppresses everything.
 */
export function isWithinQuietHours(pref: EffectivePreference, nowIso: string): boolean {
  if (!pref.quietHoursEnabled) return false
  if (!pref.quietHoursStart || !pref.quietHoursEnd) return false
  const start = toMinutes(pref.quietHoursStart)
  const end = toMinutes(pref.quietHoursEnd)
  if (start === end) return false
  const local = toWorkspaceLocalParts(nowIso, pref.timezone)
  const current = local.hour * 60 + local.minute
  if (start < end) return current >= start && current < end
  return current >= start || current < end
}
