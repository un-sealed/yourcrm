import { describe, expect, test } from "bun:test"
import {
  defaultPreference,
  isChannelEnabled,
  isWithinQuietHours,
  resolveChannels,
  toEffectivePreference,
  type EffectivePreference,
} from "./preferences"
import { DEFAULT_CHANNEL_TOGGLES } from "./schemas"

describe("notifications/preferences", () => {
  test("defaultPreference: in-app on, everything else off, no quiet hours", () => {
    const pref = defaultPreference()
    expect(resolveChannels(pref, "general")).toEqual(DEFAULT_CHANNEL_TOGGLES)
    expect(isChannelEnabled(pref, "general", "in_app")).toBe(true)
    expect(isChannelEnabled(pref, "general", "email")).toBe(false)
  })

  test("toEffectivePreference: null row resolves to the default", () => {
    expect(toEffectivePreference(null)).toEqual(defaultPreference())
  })

  test("toEffectivePreference: empty timezone falls back to UTC", () => {
    const effective = toEffectivePreference({
      id: "p1",
      workspaceId: "ws1",
      userId: "u1",
      categories: {},
      quietHoursEnabled: false,
      quietHoursStart: null,
      quietHoursEnd: null,
      timezone: "",
    })
    expect(effective.timezone).toBe("UTC")
  })

  test("resolveChannels: an override merges with the default, missing channels stay default", () => {
    const pref: EffectivePreference = {
      ...defaultPreference(),
      categories: { mention: { in_app: false, email: true } },
    }
    expect(resolveChannels(pref, "mention")).toEqual({
      in_app: false,
      email: true,
      push: false,
      sms: false,
    })
    // Untouched category still uses the default.
    expect(resolveChannels(pref, "deal_stage")).toEqual(DEFAULT_CHANNEL_TOGGLES)
  })

  describe("isWithinQuietHours", () => {
    test("disabled: never quiet", () => {
      const pref: EffectivePreference = {
        ...defaultPreference(),
        quietHoursEnabled: false,
        quietHoursStart: "22:00",
        quietHoursEnd: "07:00",
      }
      expect(isWithinQuietHours(pref, "2026-01-01T23:30:00.000Z")).toBe(false)
    })

    test("enabled but no window configured: never quiet", () => {
      const pref: EffectivePreference = { ...defaultPreference(), quietHoursEnabled: true }
      expect(isWithinQuietHours(pref, "2026-01-01T23:30:00.000Z")).toBe(false)
    })

    test("equal start/end is treated as no window, not all-day", () => {
      const pref: EffectivePreference = {
        ...defaultPreference(),
        quietHoursEnabled: true,
        quietHoursStart: "09:00",
        quietHoursEnd: "09:00",
      }
      expect(isWithinQuietHours(pref, "2026-01-01T09:00:00.000Z")).toBe(false)
    })

    test("same-day window: inside and outside, UTC", () => {
      const pref: EffectivePreference = {
        ...defaultPreference(),
        quietHoursEnabled: true,
        quietHoursStart: "13:00",
        quietHoursEnd: "15:00",
      }
      expect(isWithinQuietHours(pref, "2026-01-01T13:30:00.000Z")).toBe(true)
      expect(isWithinQuietHours(pref, "2026-01-01T15:00:00.000Z")).toBe(false) // end is exclusive
      expect(isWithinQuietHours(pref, "2026-01-01T12:59:00.000Z")).toBe(false)
    })

    test("overnight window wraps around midnight", () => {
      const pref: EffectivePreference = {
        ...defaultPreference(),
        quietHoursEnabled: true,
        quietHoursStart: "22:00",
        quietHoursEnd: "07:00",
      }
      expect(isWithinQuietHours(pref, "2026-01-01T23:00:00.000Z")).toBe(true)
      expect(isWithinQuietHours(pref, "2026-01-02T06:59:00.000Z")).toBe(true)
      expect(isWithinQuietHours(pref, "2026-01-02T12:00:00.000Z")).toBe(false)
    })

    test("evaluated in the preference timezone, not UTC", () => {
      const pref: EffectivePreference = {
        ...defaultPreference(),
        quietHoursEnabled: true,
        quietHoursStart: "22:00",
        quietHoursEnd: "07:00",
        timezone: "America/New_York",
      }
      // 2026-06-15T02:30:00Z is 22:30 the previous day in America/New_York (EDT, UTC-4) — inside the window.
      expect(isWithinQuietHours(pref, "2026-06-15T02:30:00.000Z")).toBe(true)
      // 2026-06-15T14:30:00Z is 10:30 in America/New_York — outside the window.
      expect(isWithinQuietHours(pref, "2026-06-15T14:30:00.000Z")).toBe(false)
    })
  })
})
