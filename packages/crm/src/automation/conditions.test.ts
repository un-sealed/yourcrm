import { describe, expect, test } from "bun:test"
import {
  matchesWorkflowConditions,
  matchesWorkflowTrigger,
  renderWorkflowTemplate,
  toWorkflowConditionRecord,
} from "./conditions"
import type { WorkflowTriggerEnvelope } from "./types"

const event: WorkflowTriggerEnvelope = {
  eventId: "evt_1",
  event: "deal.stage_changed",
  workspaceId: "ws_1",
  actorId: "user_1",
  entityType: "deal",
  entityId: "deal_1",
  before: { stage: "proposal", amount: 1000 },
  after: { stage: "won", amount: 5000, title: "Acme renewal" },
}

function group(children: unknown[], combinator: "and" | "or" = "and") {
  return { type: "group", id: "g1", combinator, children }
}

function condition(field: string, operator: string, value?: unknown) {
  return { type: "condition", id: `c-${field}-${operator}`, field, operator, value }
}

describe("automation/condition-record", () => {
  test("after-state wins, with before./after./event. prefixes available", () => {
    const record = toWorkflowConditionRecord(event)
    expect(record.stage).toBe("won")
    expect(record["before.stage"]).toBe("proposal")
    expect(record["after.stage"]).toBe("won")
    expect(record["event.name"]).toBe("deal.stage_changed")
    expect(record["event.entityId"]).toBe("deal_1")
    expect(record["event.actorType"]).toBe("user")
  })
})

describe("automation/conditions", () => {
  test("absent conditions and an empty group both mean always", () => {
    expect(matchesWorkflowConditions(null, event)).toBe(true)
    expect(matchesWorkflowConditions(undefined, event)).toBe(true)
    expect(matchesWorkflowConditions(group([]), event)).toBe(true)
  })

  test("a malformed tree never fires actions", () => {
    expect(matchesWorkflowConditions({ nope: true }, event)).toBe(false)
    expect(matchesWorkflowConditions(condition("stage", "eq", "won"), event)).toBe(false)
  })

  test("an unknown operator is false, not true", () => {
    expect(matchesWorkflowConditions(group([condition("stage", "matches", "w")]), event)).toBe(
      false,
    )
  })

  test("equality is case-insensitive and type-tolerant", () => {
    expect(matchesWorkflowConditions(group([condition("stage", "eq", "WON")]), event)).toBe(true)
    expect(matchesWorkflowConditions(group([condition("amount", "eq", "5000")]), event)).toBe(true)
    expect(matchesWorkflowConditions(group([condition("stage", "neq", "lost")]), event)).toBe(true)
  })

  test("text operators", () => {
    expect(matchesWorkflowConditions(group([condition("title", "contains", "renew")]), event)).toBe(
      true,
    )
    expect(
      matchesWorkflowConditions(group([condition("title", "startsWith", "acme")]), event),
    ).toBe(true)
    expect(matchesWorkflowConditions(group([condition("title", "endsWith", "xyz")]), event)).toBe(
      false,
    )
  })

  test("numeric comparison and between", () => {
    expect(matchesWorkflowConditions(group([condition("amount", "gt", 1000)]), event)).toBe(true)
    expect(matchesWorkflowConditions(group([condition("amount", "lte", 4999)]), event)).toBe(false)
    expect(
      matchesWorkflowConditions(group([condition("amount", "between", [1000, 10000])]), event),
    ).toBe(true)
  })

  test("membership and emptiness", () => {
    expect(
      matchesWorkflowConditions(group([condition("stage", "in", ["won", "lost"])]), event),
    ).toBe(true)
    expect(matchesWorkflowConditions(group([condition("stage", "notIn", ["won"])]), event)).toBe(
      false,
    )
    expect(matchesWorkflowConditions(group([condition("missing", "isEmpty")]), event)).toBe(true)
    expect(matchesWorkflowConditions(group([condition("stage", "isNotEmpty")]), event)).toBe(true)
  })

  test("and/or groups nest", () => {
    const tree = group([
      condition("stage", "eq", "won"),
      group([condition("amount", "gt", 100000), condition("title", "contains", "acme")], "or"),
    ])
    expect(matchesWorkflowConditions(tree, event)).toBe(true)
    const failing = group([condition("stage", "eq", "won"), condition("amount", "gt", 100000)])
    expect(matchesWorkflowConditions(failing, event)).toBe(false)
  })

  test("change detection uses the before. prefix", () => {
    const tree = group([
      condition("before.stage", "eq", "proposal"),
      condition("stage", "eq", "won"),
    ])
    expect(matchesWorkflowConditions(tree, event)).toBe(true)
  })
})

describe("automation/trigger-match", () => {
  test("event name must match", () => {
    expect(matchesWorkflowTrigger({ triggerEvent: "deal.stage_changed" }, event)).toBe(true)
    expect(matchesWorkflowTrigger({ triggerEvent: "deal.won" }, event)).toBe(false)
  })

  test("entity type narrows only when set", () => {
    const base = { triggerEvent: "deal.stage_changed" }
    expect(matchesWorkflowTrigger({ ...base, triggerEntityType: null }, event)).toBe(true)
    expect(matchesWorkflowTrigger({ ...base, triggerEntityType: "deal" }, event)).toBe(true)
    expect(matchesWorkflowTrigger({ ...base, triggerEntityType: "person" }, event)).toBe(false)
  })
})

describe("automation/template", () => {
  test("placeholders resolve from the triggering record", () => {
    const record = toWorkflowConditionRecord(event)
    expect(renderWorkflowTemplate("Follow up on {{title}} ({{stage}})", record)).toBe(
      "Follow up on Acme renewal (won)",
    )
  })

  test("unknown and non-scalar fields render empty, never the placeholder", () => {
    expect(renderWorkflowTemplate("x{{nope}}y", {})).toBe("xy")
    expect(renderWorkflowTemplate("x{{obj}}y", { obj: { a: 1 } })).toBe("xy")
  })

  test("only [\\w.] is accepted inside the braces", () => {
    expect(renderWorkflowTemplate("{{ a.b }}", { "a.b": "ok" })).toBe("ok")
    expect(renderWorkflowTemplate("{{drop table}}", {})).toBe("{{drop table}}")
  })
})
