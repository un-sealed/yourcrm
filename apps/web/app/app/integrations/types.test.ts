import { describe, expect, test } from "bun:test"
import {
  capabilityLabel,
  connectionsForProvider,
  groupProvidersByCategory,
  statusLabel,
  statusTone,
  type IntegrationConnection,
  type IntegrationProviderSummary,
} from "./types"

function provider(id: string, category: string, displayName = id): IntegrationProviderSummary {
  return {
    id,
    displayName,
    category,
    capabilities: ["email.send"],
    authKind: "api_key",
    supportsWebhooks: false,
    connectionCount: 0,
  }
}

function connection(id: string, providerId: string, createdAt: string): IntegrationConnection {
  return {
    id,
    workspaceId: "ws_1",
    providerId,
    displayName: id,
    status: "connected",
    authKind: "api_key",
    createdAt,
  }
}

describe("integrations/view helpers", () => {
  test("status tone and label never rely on color alone", () => {
    expect(statusTone("connected")).toBe("success")
    expect(statusTone("error")).toBe("destructive")
    expect(statusTone("disconnected")).toBe("secondary")
    expect(statusLabel("connected")).toBe("Connected")
    expect(statusLabel("weird")).toBe("weird")
  })

  test("capability labels are readable", () => {
    expect(capabilityLabel("email.send")).toBe("email · send")
    expect(capabilityLabel("payments")).toBe("payments")
  })

  test("connections are filtered per provider, newest first", () => {
    const rows = [
      connection("a", "mailer", "2026-01-01T00:00:00Z"),
      connection("b", "dialer", "2026-02-01T00:00:00Z"),
      connection("c", "mailer", "2026-03-01T00:00:00Z"),
    ]
    expect(connectionsForProvider(rows, "mailer").map((row) => row.id)).toEqual(["c", "a"])
    expect(connectionsForProvider(rows, "none")).toEqual([])
  })

  test("the catalogue groups by category, alphabetically", () => {
    const groups = groupProvidersByCategory([
      provider("zeta", "email", "Zeta"),
      provider("alpha", "email", "Alpha"),
      provider("dialer", "calling", "Dialer"),
    ])
    expect(groups.map((group) => group.category)).toEqual(["calling", "email"])
    expect(groups[1]?.providers.map((p) => p.id)).toEqual(["alpha", "zeta"])
  })
})
