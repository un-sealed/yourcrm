import { afterEach, describe, expect, test } from "bun:test"
import {
  channelSize,
  joinChannel,
  publishToChannel,
  resetRealtimeHub,
  workspaceChannel,
  type RealtimeClient,
} from "./hub"

function fakeClient() {
  const received: string[] = []
  const client: RealtimeClient = { send: (data) => received.push(data) }
  return { client, received }
}

describe("realtime/hub", () => {
  afterEach(() => {
    resetRealtimeHub()
  })

  test("workspaceChannel formats the documented channel name", () => {
    expect(workspaceChannel("ws_1")).toBe("workspace:ws_1")
  })

  test("publish fans out to every subscriber on the channel, JSON-encoded", () => {
    const a = fakeClient()
    const b = fakeClient()
    joinChannel("workspace:ws_1", a.client)
    joinChannel("workspace:ws_1", b.client)
    publishToChannel("workspace:ws_1", { type: "notification.created", entityId: "n1" })
    expect(a.received).toEqual([JSON.stringify({ type: "notification.created", entityId: "n1" })])
    expect(b.received).toEqual(a.received)
  })

  test("publish never crosses channels", () => {
    const a = fakeClient()
    joinChannel("workspace:ws_1", a.client)
    publishToChannel("workspace:ws_2", { type: "notification.created" })
    expect(a.received).toEqual([])
  })

  test("unsubscribe stops further delivery and empties the channel", () => {
    const a = fakeClient()
    const leave = joinChannel("workspace:ws_1", a.client)
    expect(channelSize("workspace:ws_1")).toBe(1)
    leave()
    expect(channelSize("workspace:ws_1")).toBe(0)
    publishToChannel("workspace:ws_1", { type: "notification.created" })
    expect(a.received).toEqual([])
  })

  test("a throwing subscriber does not block delivery to the others", () => {
    const broken: RealtimeClient = {
      send: () => {
        throw new Error("socket closed")
      },
    }
    const ok = fakeClient()
    joinChannel("workspace:ws_1", broken)
    joinChannel("workspace:ws_1", ok.client)
    expect(() => publishToChannel("workspace:ws_1", { type: "x" })).not.toThrow()
    expect(ok.received).toHaveLength(1)
  })

  test("publishing to an unknown channel is a no-op", () => {
    expect(() => publishToChannel("workspace:missing", {})).not.toThrow()
  })
})
