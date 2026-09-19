import { describe, expect, test } from "bun:test"
import { Toaster, toast, toastStore } from "./toast"
import { expand, findAll, html, only, textOf } from "./test-helpers"

describe("ui/toastStore", () => {
  test("push/dismiss/clear manage the toast list", () => {
    toastStore.clear()
    const id = toast({ title: "Saved", description: "Contact updated.", tone: "success" })
    expect(typeof id).toBe("string")
    expect(toastStore.getSnapshot().map((item) => item.title)).toEqual(["Saved"])
    toastStore.dismiss(id)
    expect(toastStore.getSnapshot()).toEqual([])
    toast({ title: "One" })
    toast({ title: "Two" })
    expect(toastStore.getSnapshot().length).toBe(2)
    toastStore.clear()
    expect(toastStore.getSnapshot()).toEqual([])
  })

  test("pushing the same id replaces the toast", () => {
    toastStore.clear()
    toast({ id: "fixed", title: "First" })
    toast({ id: "fixed", title: "Second" })
    expect(toastStore.getSnapshot().map((item) => item.title)).toEqual(["Second"])
    toastStore.clear()
  })

  test("subscribers are notified on change", () => {
    toastStore.clear()
    let calls = 0
    const unsubscribe = toastStore.subscribe(() => {
      calls += 1
    })
    toast({ title: "Hello" })
    expect(calls).toBe(1)
    unsubscribe()
    toast({ title: "Silent" })
    expect(calls).toBe(1)
    toastStore.clear()
  })
})

describe("ui/Toaster", () => {
  test("renders nothing without toasts", () => {
    expect(html(<Toaster toasts={[]} />)).toBe("")
  })

  test("renders toast titles and descriptions in a live region", () => {
    const node = only(
      expand(
        <Toaster
          toasts={[{ id: "t1", title: "Saved", description: "All changes kept.", tone: "success" }]}
        />,
      ),
    )
    expect(node.props["role"]).toBe("status")
    expect(node.props["aria-live"]).toBe("polite")
    expect(textOf(node)).toContain("Saved")
    expect(textOf(node)).toContain("All changes kept.")
  })

  test("primary interaction: dismiss button reports the toast id", () => {
    const dismissed: { value: string | null } = { value: null }
    const node = only(
      expand(
        <Toaster
          toasts={[{ id: "t1", title: "Saved" }]}
          onDismiss={(id) => {
            dismissed.value = id
          }}
        />,
      ),
    )
    const buttons = findAll([node], (candidate) => candidate.type === "button")
    expect(buttons.length).toBe(1)
    const button = buttons[0] as (typeof buttons)[number] | undefined
    ;(button?.props["onClick"] as () => void)()
    expect(dismissed.value).toBe("t1")
  })
})
