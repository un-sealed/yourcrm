"use client"

import { useMemo } from "react"
import {
  Button,
  Field,
  FilterBuilder,
  Select,
  TextArea,
  TextField,
  createFilterId,
  emptyFilterTree,
  type FilterTree,
} from "@yourcrm/ui"
import {
  ACTION_TYPE_OPTIONS,
  describeActionProblem,
  emptyWorkflowAction,
  objectTypeOfTrigger,
  toConditionFields,
  type WorkflowAction,
  type WorkflowActionType,
  type WorkflowCatalogue,
} from "./types"

export type WorkflowDraft = {
  name: string
  description: string
  triggerEvent: string
  conditions: FilterTree | null
  actions: WorkflowAction[]
}

export type WorkflowEditorProps = {
  draft: WorkflowDraft
  catalogue: WorkflowCatalogue | null
  disabled?: boolean
  onChange: (draft: WorkflowDraft) => void
}

/**
 * Progressive workflow form: trigger first, then optional conditions, then
 * the ordered actions. Shared by the create and edit pages so both post
 * exactly the shape the API validates.
 *
 * The condition editor is the shared `FilterBuilder` — this module adds no
 * second filter UI and no second filter model.
 */
export function WorkflowEditor({
  draft,
  catalogue,
  disabled = false,
  onChange,
}: WorkflowEditorProps) {
  const objectType = objectTypeOfTrigger(draft.triggerEvent)
  const conditionFields = useMemo(
    () => toConditionFields(catalogue, objectType),
    [catalogue, objectType],
  )
  const triggerOptions = useMemo(
    () => (catalogue?.triggers ?? []).map((t) => ({ value: t.event, label: t.label })),
    [catalogue],
  )
  const targetFields = useMemo(
    () => catalogue?.targets.find((t) => t.objectType === objectType)?.fields ?? [],
    [catalogue, objectType],
  )
  const maxActions = catalogue?.maxActions ?? 20

  const patch = (next: Partial<WorkflowDraft>) => onChange({ ...draft, ...next })

  const updateAction = (index: number, next: WorkflowAction) =>
    patch({ actions: draft.actions.map((action, i) => (i === index ? next : action)) })

  const moveAction = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= draft.actions.length) return
    const actions = [...draft.actions]
    const moved = actions[index]
    const swapped = actions[target]
    if (moved === undefined || swapped === undefined) return
    actions[index] = swapped
    actions[target] = moved
    patch({ actions })
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          1. Name it
        </h2>
        <Field label="Name" htmlFor="workflow-name" required>
          <TextField
            id="workflow-name"
            value={draft.name}
            disabled={disabled}
            placeholder="Welcome new people"
            onChange={(e) => patch({ name: e.target.value })}
          />
        </Field>
        <Field label="Description" htmlFor="workflow-description" hint="Optional.">
          <TextArea
            id="workflow-description"
            rows={2}
            value={draft.description}
            disabled={disabled}
            onChange={(e) => patch({ description: e.target.value })}
          />
        </Field>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          2. When this happens
        </h2>
        <Field
          label="Trigger"
          htmlFor="workflow-trigger"
          required
          hint="Only real CRM events can start an automation — an automation's own events cannot."
        >
          <Select
            id="workflow-trigger"
            value={draft.triggerEvent}
            disabled={disabled}
            placeholder="Choose an event"
            options={triggerOptions}
            onChange={(e) => patch({ triggerEvent: e.target.value })}
          />
        </Field>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          3. Only if (optional)
        </h2>
        {draft.conditions === null ? (
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => patch({ conditions: emptyFilterTree(createFilterId("group")) })}
            >
              Add conditions
            </Button>
            <p className="mt-1 text-xs text-muted-foreground">
              With no conditions the automation runs on every matching event.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <FilterBuilder
              value={draft.conditions}
              fields={conditionFields}
              onChange={(tree) => patch({ conditions: tree })}
            />
            <div>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => patch({ conditions: null })}
              >
                Remove conditions
              </Button>
            </div>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          4. Do this
        </h2>
        <p className="text-xs text-muted-foreground">
          Actions run in order and stop at the first failure. They run with the automation
          owner&apos;s permissions — never more. Use <code>{"{{field}}"}</code> to insert a value
          from the record.
        </p>

        <ol className="flex flex-col gap-3">
          {draft.actions.map((action, index) => {
            const problem = describeActionProblem(action)
            return (
              <li key={index} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Select
                    className="max-w-[16rem]"
                    aria-label={`Action ${index + 1} type`}
                    value={action.type}
                    disabled={disabled}
                    options={ACTION_TYPE_OPTIONS}
                    onChange={(e) =>
                      updateAction(index, emptyWorkflowAction(e.target.value as WorkflowActionType))
                    }
                  />
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled || index === 0}
                      aria-label={`Move action ${index + 1} up`}
                      onClick={() => moveAction(index, -1)}
                    >
                      Up
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled || index === draft.actions.length - 1}
                      aria-label={`Move action ${index + 1} down`}
                      onClick={() => moveAction(index, 1)}
                    >
                      Down
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={disabled || draft.actions.length === 1}
                      aria-label={`Remove action ${index + 1}`}
                      onClick={() =>
                        patch({ actions: draft.actions.filter((_item, i) => i !== index) })
                      }
                    >
                      Remove
                    </Button>
                  </div>
                </div>

                <div className="mt-3 flex flex-col gap-2">
                  {action.type === "create_task" ? (
                    <>
                      <Field label="Task title" htmlFor={`action-${index}-title`} required>
                        <TextField
                          id={`action-${index}-title`}
                          value={action.title}
                          disabled={disabled}
                          placeholder="Follow up with {{firstName}}"
                          onChange={(e) =>
                            updateAction(index, { ...action, title: e.target.value })
                          }
                        />
                      </Field>
                      <Field label="Due in (days)" htmlFor={`action-${index}-due`}>
                        <TextField
                          id={`action-${index}-due`}
                          type="number"
                          min={0}
                          max={365}
                          value={action.dueInDays ?? ""}
                          disabled={disabled}
                          onChange={(e) =>
                            updateAction(index, {
                              ...action,
                              dueInDays: e.target.value === "" ? null : Number(e.target.value),
                            })
                          }
                        />
                      </Field>
                    </>
                  ) : null}

                  {action.type === "update_field" ? (
                    <>
                      <Field label="Field" htmlFor={`action-${index}-field`} required>
                        <Select
                          id={`action-${index}-field`}
                          value={action.field}
                          disabled={disabled}
                          placeholder={
                            targetFields.length === 0
                              ? "This record type cannot be updated by automations"
                              : "Choose a field"
                          }
                          options={targetFields.map((name) => ({ value: name, label: name }))}
                          onChange={(e) =>
                            updateAction(index, { ...action, field: e.target.value })
                          }
                        />
                      </Field>
                      <Field label="New value" htmlFor={`action-${index}-value`}>
                        <TextField
                          id={`action-${index}-value`}
                          value={String(action.value ?? "")}
                          disabled={disabled}
                          onChange={(e) =>
                            updateAction(index, { ...action, value: e.target.value })
                          }
                        />
                      </Field>
                    </>
                  ) : null}

                  {action.type === "add_tag" ? (
                    <Field label="Tag" htmlFor={`action-${index}-tag`} required>
                      <TextField
                        id={`action-${index}-tag`}
                        value={action.tag}
                        disabled={disabled}
                        placeholder="vip"
                        onChange={(e) => updateAction(index, { ...action, tag: e.target.value })}
                      />
                    </Field>
                  ) : null}

                  {action.type === "notify" ? (
                    <>
                      <Field label="Notification title" htmlFor={`action-${index}-notify`} required>
                        <TextField
                          id={`action-${index}-notify`}
                          value={action.title}
                          disabled={disabled}
                          placeholder="New lead: {{firstName}}"
                          onChange={(e) =>
                            updateAction(index, { ...action, title: e.target.value })
                          }
                        />
                      </Field>
                      <Field
                        label="Notify user id"
                        htmlFor={`action-${index}-user`}
                        hint="Leave blank to notify the automation owner."
                      >
                        <TextField
                          id={`action-${index}-user`}
                          value={action.userId ?? ""}
                          disabled={disabled}
                          onChange={(e) =>
                            updateAction(index, {
                              ...action,
                              userId: e.target.value === "" ? null : e.target.value,
                            })
                          }
                        />
                      </Field>
                    </>
                  ) : null}

                  {problem !== null ? (
                    <p role="alert" className="text-xs text-destructive">
                      {problem}
                    </p>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ol>

        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || draft.actions.length >= maxActions}
            onClick={() =>
              patch({ actions: [...draft.actions, emptyWorkflowAction("create_task")] })
            }
          >
            Add action
          </Button>
          {draft.actions.length >= maxActions ? (
            <p className="mt-1 text-xs text-muted-foreground">
              An automation may have at most {maxActions} actions.
            </p>
          ) : null}
        </div>
      </section>
    </div>
  )
}

/** Body for POST/PATCH — drops the empty strings the API would reject. */
export function toWorkflowPayload(draft: WorkflowDraft): Record<string, unknown> {
  return {
    name: draft.name.trim(),
    description: draft.description.trim() === "" ? null : draft.description.trim(),
    triggerEvent: draft.triggerEvent,
    conditions: draft.conditions,
    actions: draft.actions,
  }
}

/** True when the draft would pass the server's validation. */
export function isWorkflowDraftValid(draft: WorkflowDraft): boolean {
  return (
    draft.name.trim() !== "" &&
    draft.triggerEvent !== "" &&
    draft.actions.length > 0 &&
    draft.actions.every((action) => describeActionProblem(action) === null)
  )
}
