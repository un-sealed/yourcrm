"use client"

import { Badge, Button, Field, Select, TextArea, TextField } from "@yourcrm/ui"
import { formatDelay, type SequenceCatalogue, type SequenceStepType } from "./types"

/**
 * Sequence step editor (spec 47 §4, P0).
 *
 * The editor owns an ordered DRAFT list and hands the whole list back on
 * save — `PUT /api/v1/sequences/:id/steps` replaces it, and the server
 * re-derives `stepIndex` from array position. A diff-based editor would
 * let the stored order disagree with the order on screen; a list cannot.
 *
 * Editing a live sequence is allowed. Steps a prospect has already passed
 * are never re-run (idempotency is keyed on (enrollment, step index)), so
 * fixing a typo in step 3 while step 1 is in flight is safe — the banner
 * on the detail page says so.
 */

export type SequenceStepDraft = {
  stepType: SequenceStepType
  name: string
  waitDays: number
  waitHours: number
  subject: string
  bodyText: string
  title: string
  description: string
  priority: "" | "low" | "medium" | "high" | "urgent"
  dueInDays: number
}

export function emptySequenceStep(stepType: SequenceStepType): SequenceStepDraft {
  return {
    stepType,
    name: "",
    waitDays: stepType === "wait" ? 1 : stepType === "email" ? 3 : 0,
    waitHours: 0,
    subject: "",
    bodyText: "",
    title: "",
    description: "",
    priority: "",
    dueInDays: 0,
  }
}

/** Turn the stored representation back into an editable draft. */
export function toSequenceStepDraft(step: {
  stepType: string
  name: string | null
  waitDays: number
  waitHours: number
  config: Record<string, unknown>
}): SequenceStepDraft {
  const stepType = (["email", "task", "wait"] as const).includes(step.stepType as SequenceStepType)
    ? (step.stepType as SequenceStepType)
    : "wait"
  const config = step.config ?? {}
  const str = (key: string): string => (typeof config[key] === "string" ? String(config[key]) : "")
  const priority = str("priority")
  return {
    stepType,
    name: step.name ?? "",
    waitDays: step.waitDays,
    waitHours: step.waitHours,
    subject: str("subject"),
    bodyText: str("bodyText"),
    title: str("title"),
    description: str("description"),
    priority: (["low", "medium", "high", "urgent"] as const).includes(
      priority as "low" | "medium" | "high" | "urgent",
    )
      ? (priority as "low" | "medium" | "high" | "urgent")
      : "",
    dueInDays: typeof config.dueInDays === "number" ? config.dueInDays : 0,
  }
}

/** The request body `PUT /:id/steps` expects. Mirrors the zod union. */
export function toSequenceStepsPayload(steps: SequenceStepDraft[]): {
  steps: Record<string, unknown>[]
} {
  return {
    steps: steps.map((step) => {
      const shared = {
        stepType: step.stepType,
        name: step.name.trim() === "" ? null : step.name.trim(),
        waitDays: step.waitDays,
        waitHours: step.waitHours,
      }
      if (step.stepType === "email") {
        return { ...shared, subject: step.subject.trim(), bodyText: step.bodyText }
      }
      if (step.stepType === "task") {
        return {
          ...shared,
          title: step.title.trim(),
          description: step.description.trim() === "" ? null : step.description,
          priority: step.priority === "" ? null : step.priority,
          dueInDays: step.dueInDays > 0 ? step.dueInDays : null,
        }
      }
      return shared
    }),
  }
}

/** Client-side mirror of the server's rules. The server still decides. */
export function isSequenceStepValid(step: SequenceStepDraft): boolean {
  if (step.stepType === "email") {
    return step.subject.trim() !== "" && step.bodyText.trim() !== ""
  }
  if (step.stepType === "task") return step.title.trim() !== ""
  return step.waitDays > 0 || step.waitHours > 0
}

export function areSequenceStepsValid(steps: SequenceStepDraft[]): boolean {
  return steps.length > 0 && steps.every(isSequenceStepValid)
}

function moveStep(steps: SequenceStepDraft[], from: number, to: number): SequenceStepDraft[] {
  if (to < 0 || to >= steps.length) return steps
  const next = [...steps]
  const [moved] = next.splice(from, 1)
  if (!moved) return steps
  next.splice(to, 0, moved)
  return next
}

export type SequenceStepEditorProps = {
  steps: SequenceStepDraft[]
  catalogue: SequenceCatalogue | null
  disabled?: boolean
  onChange: (steps: SequenceStepDraft[]) => void
}

export function SequenceStepEditor({
  steps,
  catalogue,
  disabled = false,
  onChange,
}: SequenceStepEditorProps) {
  const maxSteps = catalogue?.maxSteps ?? 30
  const maxWaitDays = catalogue?.maxWaitDays ?? 365
  const maxWaitHours = catalogue?.maxWaitHours ?? 23
  const stepTypeOptions = catalogue?.stepTypes.map((entry) => ({
    value: entry.type,
    label: entry.label,
  })) ?? [
    { value: "email", label: "Send an email" },
    { value: "task", label: "Create a task" },
    { value: "wait", label: "Wait" },
  ]

  const patch = (index: number, changes: Partial<SequenceStepDraft>) => {
    onChange(steps.map((step, i) => (i === index ? { ...step, ...changes } : step)))
  }

  return (
    <section className="flex flex-col gap-4" aria-label="Sequence steps">
      {steps.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No steps yet. A sequence needs at least one step before it can be activated.
        </p>
      ) : null}

      <ol className="flex flex-col gap-4">
        {steps.map((step, index) => (
          <li key={index} className="rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <Badge tone="outline">Step {index + 1}</Badge>
                <span className="text-sm text-muted-foreground">
                  {index === 0 ? "Starts" : "Runs"} {formatDelay(step.waitDays, step.waitHours)}
                  {index === 0 ? " after enrolment" : " after the previous step"}
                </span>
              </span>
              <span className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled || index === 0}
                  aria-label={`Move step ${index + 1} up`}
                  onClick={() => onChange(moveStep(steps, index, index - 1))}
                >
                  Up
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled || index === steps.length - 1}
                  aria-label={`Move step ${index + 1} down`}
                  onClick={() => onChange(moveStep(steps, index, index + 1))}
                >
                  Down
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  aria-label={`Remove step ${index + 1}`}
                  onClick={() => onChange(steps.filter((_, i) => i !== index))}
                >
                  Remove
                </Button>
              </span>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Field label="Step type" htmlFor={`step-${index}-type`}>
                <Select
                  id={`step-${index}-type`}
                  value={step.stepType}
                  disabled={disabled}
                  options={stepTypeOptions}
                  onChange={(e) => {
                    const stepType = e.currentTarget.value as SequenceStepType
                    patch(index, {
                      ...emptySequenceStep(stepType),
                      name: step.name,
                      waitDays: step.waitDays,
                      waitHours: step.waitHours,
                      stepType,
                    })
                  }}
                />
              </Field>
              <Field label="Wait (days)" htmlFor={`step-${index}-days`}>
                <TextField
                  id={`step-${index}-days`}
                  type="number"
                  min={0}
                  max={maxWaitDays}
                  value={String(step.waitDays)}
                  disabled={disabled}
                  onChange={(e) =>
                    patch(index, { waitDays: Math.max(0, Number(e.currentTarget.value) || 0) })
                  }
                />
              </Field>
              <Field label="Wait (hours)" htmlFor={`step-${index}-hours`}>
                <TextField
                  id={`step-${index}-hours`}
                  type="number"
                  min={0}
                  max={maxWaitHours}
                  value={String(step.waitHours)}
                  disabled={disabled}
                  onChange={(e) =>
                    patch(index, { waitHours: Math.max(0, Number(e.currentTarget.value) || 0) })
                  }
                />
              </Field>
            </div>

            {step.stepType === "email" ? (
              <div className="mt-3 flex flex-col gap-3">
                <Field
                  label="Subject"
                  htmlFor={`step-${index}-subject`}
                  required
                  hint="Use {{email}} to personalise."
                >
                  <TextField
                    id={`step-${index}-subject`}
                    value={step.subject}
                    disabled={disabled}
                    invalid={step.subject.trim() === ""}
                    onChange={(e) => patch(index, { subject: e.currentTarget.value })}
                  />
                </Field>
                <Field label="Body" htmlFor={`step-${index}-body`} required>
                  <TextArea
                    id={`step-${index}-body`}
                    value={step.bodyText}
                    rows={5}
                    disabled={disabled}
                    invalid={step.bodyText.trim() === ""}
                    onChange={(e) => patch(index, { bodyText: e.currentTarget.value })}
                  />
                </Field>
              </div>
            ) : null}

            {step.stepType === "task" ? (
              <div className="mt-3 flex flex-col gap-3">
                <Field label="Task title" htmlFor={`step-${index}-title`} required>
                  <TextField
                    id={`step-${index}-title`}
                    value={step.title}
                    disabled={disabled}
                    invalid={step.title.trim() === ""}
                    onChange={(e) => patch(index, { title: e.currentTarget.value })}
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Priority" htmlFor={`step-${index}-priority`}>
                    <Select
                      id={`step-${index}-priority`}
                      value={step.priority}
                      disabled={disabled}
                      options={[
                        { value: "", label: "No priority" },
                        { value: "low", label: "Low" },
                        { value: "medium", label: "Medium" },
                        { value: "high", label: "High" },
                        { value: "urgent", label: "Urgent" },
                      ]}
                      onChange={(e) =>
                        patch(index, {
                          priority: e.currentTarget.value as SequenceStepDraft["priority"],
                        })
                      }
                    />
                  </Field>
                  <Field label="Due in (days)" htmlFor={`step-${index}-due`}>
                    <TextField
                      id={`step-${index}-due`}
                      type="number"
                      min={0}
                      max={365}
                      value={String(step.dueInDays)}
                      disabled={disabled}
                      onChange={(e) =>
                        patch(index, {
                          dueInDays: Math.max(0, Number(e.currentTarget.value) || 0),
                        })
                      }
                    />
                  </Field>
                </div>
              </div>
            ) : null}

            {step.stepType === "wait" && step.waitDays === 0 && step.waitHours === 0 ? (
              <p role="alert" className="mt-3 text-sm text-destructive">
                A wait step needs a delay of at least one hour.
              </p>
            ) : null}
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        {(["email", "task", "wait"] as const).map((stepType) => (
          <Button
            key={stepType}
            variant="outline"
            size="sm"
            disabled={disabled || steps.length >= maxSteps}
            onClick={() => onChange([...steps, emptySequenceStep(stepType)])}
          >
            Add {stepType} step
          </Button>
        ))}
        <span className="text-xs text-muted-foreground">
          {steps.length} of {maxSteps} steps
        </span>
      </div>
    </section>
  )
}
