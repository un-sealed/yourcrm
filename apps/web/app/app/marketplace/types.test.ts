import { describe, expect, test } from "bun:test"
import {
  formatScope,
  installationsForApp,
  parseScopeString,
  statusLabel,
  statusTone,
  type AppInstallation,
} from "./types"

function installation(
  id: string,
  appId: string,
  status: string,
  installedAt: string,
): AppInstallation {
  return {
    id,
    workspaceId: "ws_1",
    appId,
    appVersion: "1.0.0",
    status,
    installedAt,
  }
}

describe("marketplace/view helpers", () => {
  test("scope strings round-trip through parse/format", () => {
    expect(parseScopeString("person:read")).toEqual({ object: "person", action: "read" })
    expect(formatScope({ object: "person", action: "read" })).toBe("person · read")
  })

  test("status tone and label never rely on color alone", () => {
    expect(statusTone("active")).toBe("success")
    expect(statusTone("uninstalled")).toBe("secondary")
    expect(statusTone("published")).toBe("success")
    expect(statusLabel("active")).toBe("Installed")
    expect(statusLabel("uninstalled")).toBe("Uninstalled")
    expect(statusLabel("weird")).toBe("weird")
  })

  test("installationsForApp filters to active rows for one app, newest first", () => {
    const rows = [
      installation("i1", "app-a", "active", "2026-01-01T00:00:00Z"),
      installation("i2", "app-b", "active", "2026-02-01T00:00:00Z"),
      installation("i3", "app-a", "active", "2026-03-01T00:00:00Z"),
      installation("i4", "app-a", "uninstalled", "2026-04-01T00:00:00Z"),
    ]
    expect(installationsForApp(rows, "app-a").map((row) => row.id)).toEqual(["i3", "i1"])
    expect(installationsForApp(rows, "app-none")).toEqual([])
  })
})
