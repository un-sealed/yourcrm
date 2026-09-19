import { describe, expect, test } from "bun:test"
import {
  ACTION_TYPE_OPTIONS,
  describeAction,
  describeActionProblem,
  describeWorkflow,
  emptyWorkflowAction,
  formatRunTimestamp,
  objectTypeOfTrigger,
  RUN_STATUS_TONES,
  toConditionFields,
  type WorkflowCatalogue,
} from "./types"
import { isWorkflowDraftValid, toWorkflowPayload, type WorkflowDraft } from "./workflow-editor"

const catalogue: WorkflowCatalogue = {
  triggers: [
    { event: "person.created", label: "Person created", domain: "person" },
    { event: "deal.stage_changed", label: "Deal stage changed", domain: "deal" },
  ],
  actions: [{ type: "create_task", label: "Create a task" }],
  targets: [
    { objectType: "person", fields: ["status", "ownerId"] },
    { objectType: "deal", fields: ["amount"] },
  ],
  maxActions: 20,
  maxCascadeDepth: 5,
}

describe("automation/action-drafts", () => {
  test("every action type has a blank draft and an option", () => {
    for (const option of ACTION_TYPE_OPTIONS) {
      expect(emptyWorkflowAction(option.value).type).toBe(option.value)
    }
  })

  test("blank drafts report what is missing", () => {
    expect(describeActionProblem(emptyWorkflowAction("create_task"))).toContain("title")
    expect(describeActionProblem(emptyWorkflowAction("update_field"))).toContain("field")
    expect(describeActionProblem(emptyWorkflowAction("add_tag"))).toContain("tag")
    expect(describeActionProblem({ type: "add_tag", tag: "vip" })).toBeNull()
  })

  test("actions describe themselves for list rows", () => {
    expect(describeAction({ type: "create_task", title: "Call" })).toBe('Create task "Call"')
    expect(describeAction({ type: "update_field", field: "status", value: "hot" })).toBe(
      "Set status to hot",
    )
    expect(describeAction({ type: "notify", title: "Hi" })).toContain("the workflow owner")
  })
})

describe("automation/summaries", () => {
  test("a definition reads as when/then, with an overflow count", () => {
    expect(
      describeWorkflow(
        { triggerEvent: "person.created", actions: [{ type: "add_tag", tag: "new" }] },
        catalogue,
      ),
    ).toBe('When person created → Add tag "new"')
    expect(
      describeWorkflow(
        {
          triggerEvent: "person.created",
          actions: [
            { type: "add_tag", tag: "new" },
            { type: "create_task", title: "Call" },
          ],
        },
        catalogue,
      ),
    ).toContain("+1 more")
  })

  test("an unknown trigger falls back to the raw event name", () => {
    expect(describeWorkflow({ triggerEvent: "quote.sent", actions: [] })).toBe("When quote.sent")
  })

  test("timestamps render an em dash when absent", () => {
    expect(formatRunTimestamp(null)).toBe("—")
    expect(formatRunTimestamp("2026-01-01T00:00:00Z")).not.toBe("—")
  })

  test("every run status has a badge tone", () => {
    for (const status of ["queued", "running", "succeeded", "failed", "skipped"]) {
      expect(RUN_STATUS_TONES[status], status).toBeDefined()
    }
  })
})

describe("automation/condition-fields", () => {
  test("the builder offers the target's fields plus before-state and event metadata", () => {
    const fields = toConditionFields(catalogue, objectTypeOfTrigger("person.created"))
    const names = fields.map((f) => f.name)
    expect(names).toContain("status")
    expect(names).toContain("before.status")
    expect(names).toContain("event.actorType")
  })

  test("an unknown object still offers the event metadata", () => {
    const names = toConditionFields(catalogue, "quote").map((f) => f.name)
    expect(names).toEqual(["event.entityType", "event.actorType"])
  })

  test("the object type comes from the event domain", () => {
    expect(objectTypeOfTrigger("deal.stage_changed")).toBe("deal")
    expect(objectTypeOfTrigger("")).toBeNull()
  })
})

describe("automation/draft-validation", () => {
  const valid: WorkflowDraft = {
    name: "Welcome",
    description: "",
    triggerEvent: "person.created",
    conditions: null,
    actions: [{ type: "create_task", title: "Call {{firstName}}" }],
  }

  test("a complete draft is valid", () => {
    expect(isWorkflowDraftValid(valid)).toBe(true)
  })

  test("a draft missing a name, trigger or action is not", () => {
    expect(isWorkflowDraftValid({ ...valid, name: "  " })).toBe(false)
    expect(isWorkflowDraftValid({ ...valid, triggerEvent: "" })).toBe(false)
    expect(isWorkflowDraftValid({ ...valid, actions: [] })).toBe(false)
    expect(isWorkflowDraftValid({ ...valid, actions: [{ type: "add_tag", tag: "" }] })).toBe(false)
  })

  test("the payload trims and nulls an empty description", () => {
    const payload = toWorkflowPayload({ ...valid, name: "  Welcome  ", description: "  " })
    expect(payload.name).toBe("Welcome")
    expect(payload.description).toBeNull()
  })
})
