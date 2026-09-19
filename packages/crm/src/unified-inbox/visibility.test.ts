import { describe, expect, test } from "bun:test"
import { makeServiceContext, makeSession } from "@yourcrm/testing"
import {
  INBOX_CHANNEL_PERMISSION_OBJECTS,
  INBOX_PERMISSION_OBJECT,
  inboxVisibilityScope,
  readableInboxChannels,
} from "./visibility"
import { INBOX_CHANNEL_NAMES, isInboxChannelName } from "./types"

const WS = "11111111-1111-4111-8111-111111111111"
const ACTOR = "22222222-2222-4222-8222-222222222222"

const ctxFor = (role: "owner" | "admin" | "member" | "viewer") =>
  makeServiceContext({ session: makeSession({ role, workspaceId: WS, userId: ACTOR }) })

describe("unified-inbox/channel access", () => {
  test("each channel is gated on the source module's own object", () => {
    expect(INBOX_CHANNEL_PERMISSION_OBJECTS).toEqual({
      email: "email_thread",
      whatsapp: "whatsapp_conversation",
      call: "call",
    })
    expect(INBOX_PERMISSION_OBJECT).toBe("inbox_conversation")
  })

  test("a reader gets every channel, in stream order", () => {
    expect(readableInboxChannels(ctxFor("viewer"))).toEqual([...INBOX_CHANNEL_NAMES])
  })

  test("a requested channel narrows the list to that channel", () => {
    expect(readableInboxChannels(ctxFor("member"), "whatsapp")).toEqual(["whatsapp"])
  })

  test("an actor the foundation policy rejects gets no channels at all", () => {
    // No workspace -> `checkPermission` denies everything, so the stream is
    // empty rather than unfiltered. This is the fail-closed direction.
    const ctx = makeServiceContext({ workspaceId: "", actorId: ACTOR, role: "owner" })
    expect(readableInboxChannels(ctx)).toEqual([])
  })

  test("channel names are exactly the three implemented sources", () => {
    expect([...INBOX_CHANNEL_NAMES]).toEqual(["email", "whatsapp", "call"])
    expect(isInboxChannelName("call")).toBe(true)
    expect(isInboxChannelName("sms")).toBe(false)
    expect(isInboxChannelName(7)).toBe(false)
  })
})

describe("unified-inbox/record visibility", () => {
  test("owners and admins see the whole workspace", () => {
    expect(inboxVisibilityScope(ctxFor("owner"))).toEqual({ kind: "all" })
    expect(inboxVisibilityScope(ctxFor("admin"))).toEqual({ kind: "all" })
  })

  test("members and viewers are scoped to their own conversations", () => {
    expect(inboxVisibilityScope(ctxFor("member"))).toEqual({ kind: "own", actorId: ACTOR })
    expect(inboxVisibilityScope(ctxFor("viewer"))).toEqual({ kind: "own", actorId: ACTOR })
  })

  test("an unknown role falls back to the narrow scope, never the wide one", () => {
    const ctx = makeServiceContext({ workspaceId: WS, actorId: ACTOR, role: "contractor" })
    expect(inboxVisibilityScope(ctx)).toEqual({ kind: "own", actorId: ACTOR })
  })
})
