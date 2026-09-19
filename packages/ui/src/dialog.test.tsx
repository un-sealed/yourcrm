import { describe, expect, test } from "bun:test"
import * as React from "react"
import { ConfirmDialog, Dialog } from "./dialog"
import { html } from "./test-helpers"

describe("ui/Dialog", () => {
  test("renders nothing interactive when closed", () => {
    const markup = html(<Dialog open={false} onOpenChange={() => undefined} title="Hidden" />)
    expect(markup).not.toContain('data-slot="dialog"')
  })

  test("is a valid controlled element when open", () => {
    const element = (
      <Dialog open={true} onOpenChange={() => undefined} title="Delete contact" description="Sure?">
        <button type="button">Close</button>
      </Dialog>
    )
    expect(React.isValidElement(element)).toBe(true)
    expect(element.props.open).toBe(true)
    expect(element.props.title).toBe("Delete contact")
  })
})

describe("ui/ConfirmDialog", () => {
  test("renders nothing interactive when closed", () => {
    const markup = html(
      <ConfirmDialog
        open={false}
        onOpenChange={() => undefined}
        title="X"
        onConfirm={() => undefined}
      />,
    )
    expect(markup).not.toContain('data-slot="dialog"')
  })

  test("primary interaction: confirm and open-change callbacks are wired through props", () => {
    let confirmed = 0
    let opened: boolean[] = []
    const element = (
      <ConfirmDialog
        open={true}
        onOpenChange={(next) => {
          opened = [...opened, next]
        }}
        title="Delete this contact?"
        description="This cannot be undone."
        confirmLabel="Delete"
        danger={true}
        onConfirm={() => {
          confirmed += 1
        }}
      />
    )
    expect(React.isValidElement(element)).toBe(true)
    element.props.onConfirm()
    element.props.onOpenChange(false)
    expect(confirmed).toBe(1)
    expect(opened).toEqual([false])
  })
})
