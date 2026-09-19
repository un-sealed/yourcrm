import { describe, expect, test } from "bun:test"
import { SavedViews } from "./saved-views"
import { expand, findAll, html, only, textOf } from "./test-helpers"

const VIEWS = [
  { id: "v1", name: "My pipeline" },
  { id: "v2", name: "Closing soon" },
]

function mockSubmit(values: Record<string, string>): {
  preventDefault: () => void
  currentTarget: unknown
} {
  return {
    preventDefault: () => undefined,
    currentTarget: {
      elements: {
        namedItem: (name: string) => ({ value: values[name] ?? "" }),
      },
      reset: () => undefined,
      closest: () => null,
    },
  }
}

describe("ui/SavedViews", () => {
  test("renders view chips with active state", () => {
    const node = only(
      expand(
        <SavedViews
          views={VIEWS}
          activeId="v1"
          onSelect={() => undefined}
          onCreate={() => undefined}
          onRename={() => undefined}
          onDelete={() => undefined}
        />,
      ),
    )
    expect(textOf(node)).toContain("My pipeline")
    expect(textOf(node)).toContain("Closing soon")
    expect(
      html(
        <SavedViews
          views={VIEWS}
          activeId="v1"
          onSelect={() => undefined}
          onCreate={() => undefined}
          onRename={() => undefined}
          onDelete={() => undefined}
        />,
      ),
    ).toContain('aria-pressed="true"')
  })

  test("primary interaction: select, create, rename and delete callbacks", () => {
    const selected: { value: string | null } = { value: null }
    const created: { value: string | null } = { value: null }
    const renamed: { value: [string, string] | null } = { value: null }
    const deleted: { value: string | null } = { value: null }
    const node = only(
      expand(
        <SavedViews
          views={VIEWS}
          activeId={null}
          onSelect={(id) => {
            selected.value = id
          }}
          onCreate={(name) => {
            created.value = name
          }}
          onRename={(id, name) => {
            renamed.value = [id, name]
          }}
          onDelete={(id) => {
            deleted.value = id
          }}
        />,
      ),
    )
    const buttons = findAll([node], (candidate) => candidate.type === "button")
    const selectChip = buttons.find(
      (button) => String(button.props["aria-label"] ?? "") === "Apply view My pipeline",
    )
    ;(selectChip?.props["onClick"] as () => void)()
    expect(selected.value).toBe("v1")

    const deleteButton = buttons.find(
      (button) => String(button.props["aria-label"] ?? "") === "Delete view Closing soon",
    )
    ;(deleteButton?.props["onClick"] as () => void)()
    expect(deleted.value).toBe("v2")

    const forms = findAll([node], (candidate) => candidate.type === "form")
    const createForm = forms.find(
      (form) => String(form.props["aria-label"] ?? "") === "Create view",
    )
    ;(createForm?.props["onSubmit"] as (event: unknown) => void)(
      mockSubmit({ "new-view-name": "  Hot leads  " }),
    )
    expect(created.value).toBe("Hot leads")

    const renameForm = forms.find((form) => form.props["aria-label"] === undefined)
    ;(renameForm?.props["onSubmit"] as (event: unknown) => void)(
      mockSubmit({ "view-name": "Renamed" }),
    )
    expect(renamed.value).toEqual(["v1", "Renamed"])
  })
})
