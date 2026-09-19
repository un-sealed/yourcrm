import { describe, expect, test } from "bun:test"
import { RecordHeader } from "./record-header"
import { expand, findAll, html, only, textOf } from "./test-helpers"

describe("ui/RecordHeader", () => {
  test("renders title, subtitle, status badge and owner", () => {
    const node = only(
      expand(
        <RecordHeader
          title="Acme Corp"
          subtitle="acme.example.com"
          status={{ label: "Customer", tone: "success" }}
          owner={{ name: "Ada Lovelace" }}
          actions={<button type="button">Edit</button>}
        />,
      ),
    )
    expect(node.type).toBe("header")
    expect(textOf(node)).toContain("Acme Corp")
    expect(textOf(node)).toContain("acme.example.com")
    expect(textOf(node)).toContain("Customer")
    expect(textOf(node)).toContain("Owner: Ada Lovelace")
    expect(textOf(node)).toContain("Edit")
  })

  test("omits optional slots when not provided", () => {
    const markup = html(<RecordHeader title="Solo" />)
    expect(markup).toContain("Solo")
    expect(markup).not.toContain("Owner:")
  })

  test("primary interaction: action slot buttons stay wired", () => {
    let calls = 0
    const node = only(
      expand(
        <RecordHeader
          title="Acme"
          actions={
            <button
              type="button"
              onClick={() => {
                calls += 1
              }}
            >
              Edit
            </button>
          }
        />,
      ),
    )
    const buttons = findAll([node], (candidate) => candidate.type === "button")
    expect(buttons.length).toBe(1)
    const button = buttons[0] as (typeof buttons)[number] | undefined
    ;(button?.props["onClick"] as () => void)()
    expect(calls).toBe(1)
  })
})
