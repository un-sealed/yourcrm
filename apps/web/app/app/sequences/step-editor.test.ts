import { describe, expect, test } from "bun:test"
import {
  areSequenceStepsValid,
  emptySequenceStep,
  isSequenceStepValid,
  toSequenceStepDraft,
  toSequenceStepsPayload,
} from "./step-editor"

/**
 * The editor's pure half. Rendering is covered by the Playwright flow; the
 * part worth unit-testing is the translation between the stored row shape
 * and the request body, because getting it wrong means a step silently
 * loses its content on save.
 */

describe("sequences/step-editor", () => {
  test("a new email step defaults to a three-day gap, a wait step to one day", () => {
    expect(emptySequenceStep("email").waitDays).toBe(3)
    expect(emptySequenceStep("wait").waitDays).toBe(1)
    expect(emptySequenceStep("task").waitDays).toBe(0)
  })

  test("a stored step round-trips into an editable draft", () => {
    const draft = toSequenceStepDraft({
      stepType: "email",
      name: "Opener",
      waitDays: 2,
      waitHours: 4,
      config: { subject: "Hello", bodyText: "Hi there", bodyHtml: null },
    })
    expect(draft).toMatchObject({
      stepType: "email",
      name: "Opener",
      waitDays: 2,
      waitHours: 4,
      subject: "Hello",
      bodyText: "Hi there",
    })
  })

  test("an unknown stored step type degrades to a wait rather than crashing", () => {
    const draft = toSequenceStepDraft({
      stepType: "carrier_pigeon",
      name: null,
      waitDays: 1,
      waitHours: 0,
      config: {},
    })
    expect(draft.stepType).toBe("wait")
  })

  test("an unknown stored priority is dropped, not passed back to the server", () => {
    const draft = toSequenceStepDraft({
      stepType: "task",
      name: null,
      waitDays: 0,
      waitHours: 0,
      config: { title: "Call", priority: "catastrophic" },
    })
    expect(draft.priority).toBe("")
  })

  test("the payload matches the server's discriminated union", () => {
    const payload = toSequenceStepsPayload([
      { ...emptySequenceStep("email"), subject: " Hello ", bodyText: "Hi" },
      { ...emptySequenceStep("wait"), waitDays: 3 },
      { ...emptySequenceStep("task"), title: " Call ", priority: "high", dueInDays: 2 },
    ])
    expect(payload.steps[0]).toMatchObject({ stepType: "email", subject: "Hello", bodyText: "Hi" })
    expect(payload.steps[1]).toMatchObject({ stepType: "wait", waitDays: 3 })
    expect(payload.steps[2]).toMatchObject({
      stepType: "task",
      title: "Call",
      priority: "high",
      dueInDays: 2,
    })
    // Empty optional fields go as null, not as "".
    expect(payload.steps[2]).toMatchObject({ description: null })
    expect(payload.steps[0]).toMatchObject({ name: null })
  })

  test("a zero due date is omitted rather than sent as day zero", () => {
    const payload = toSequenceStepsPayload([{ ...emptySequenceStep("task"), title: "Call" }])
    expect(payload.steps[0]).toMatchObject({ dueInDays: null })
  })

  /** Client validation mirrors the server's; it never replaces it. */
  test("validation mirrors the server's rules", () => {
    expect(isSequenceStepValid(emptySequenceStep("email"))).toBe(false)
    expect(
      isSequenceStepValid({ ...emptySequenceStep("email"), subject: "Hi", bodyText: "Hello" }),
    ).toBe(true)
    expect(isSequenceStepValid(emptySequenceStep("task"))).toBe(false)
    expect(isSequenceStepValid({ ...emptySequenceStep("task"), title: "Call" })).toBe(true)
    // A wait step with no delay is rejected by the SQL CHECK too.
    expect(isSequenceStepValid({ ...emptySequenceStep("wait"), waitDays: 0, waitHours: 0 })).toBe(
      false,
    )
    expect(isSequenceStepValid({ ...emptySequenceStep("wait"), waitHours: 4 })).toBe(true)
  })

  test("an empty sequence is not saveable: a sequence needs a step to activate", () => {
    expect(areSequenceStepsValid([])).toBe(false)
    expect(
      areSequenceStepsValid([{ ...emptySequenceStep("email"), subject: "Hi", bodyText: "yo" }]),
    ).toBe(true)
    expect(
      areSequenceStepsValid([
        { ...emptySequenceStep("email"), subject: "Hi", bodyText: "yo" },
        emptySequenceStep("task"),
      ]),
    ).toBe(false)
  })
})
