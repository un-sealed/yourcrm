import { describe, expect, test } from "bun:test"
import { categoryLabel, resolveChannels, type NotificationPreference } from "./types"

describe("notifications/types", () => {
  test("categoryLabel: known category has a human label", () => {
    expect(categoryLabel("task_reminder")).toBe("Task reminders")
  })

  test("categoryLabel: unknown category falls back to the raw value", () => {
    expect(categoryLabel("something_new")).toBe("something_new")
  })

  test("resolveChannels: null preference defaults to in-app only", () => {
    expect(resolveChannels(null, "mention")).toEqual({
      in_app: true,
      email: false,
      push: false,
      sms: false,
    })
  })

  test("resolveChannels: an override merges with the default", () => {
    const pref: NotificationPreference = {
      id: "p1",
      workspaceId: "ws1",
      userId: "u1",
      categories: { mention: { in_app: false, email: true } },
      quietHoursEnabled: false,
      quietHoursStart: null,
      quietHoursEnd: null,
      timezone: "UTC",
    }
    expect(resolveChannels(pref, "mention")).toEqual({
      in_app: false,
      email: true,
      push: false,
      sms: false,
    })
    // Untouched category still uses the default.
    expect(resolveChannels(pref, "deal_stage")).toEqual({
      in_app: true,
      email: false,
      push: false,
      sms: false,
    })
  })
})
