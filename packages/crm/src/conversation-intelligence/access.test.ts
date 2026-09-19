import { describe, expect, test } from "bun:test"
import { makeServiceContext } from "@yourcrm/testing"
import {
  canReadConversationSubjectType,
  conversationPermission,
  conversationSubjectPermission,
  readableConversationSubjectTypes,
  CALL_TRANSCRIPT_OBJECT,
  CONVERSATION_ANALYSIS_OBJECT,
  CONVERSATION_SUBJECT_PERMISSION_OBJECTS,
} from "./access"
import { createConversationSource, createConversationSourceRegistry } from "./sources"
import type { ConversationSourceRegistry, ConversationSubjectType } from "./types"

/**
 * PROPERTY 1 — PERMISSION INHERITANCE, object-gate half. The record-gate
 * half (a user who cannot read the thread cannot read its summary) needs
 * a source and a store, so it is proved in `service.test.ts`.
 */

function registryFor(...subjectTypes: ConversationSubjectType[]): ConversationSourceRegistry {
  return createConversationSourceRegistry(
    subjectTypes.map((subjectType) =>
      createConversationSource(subjectType, {
        read: async () => null,
        filterReadable: async () => [],
      }),
    ),
  )
}

describe("conversation-intelligence/access", () => {
  test("a subject's read check uses the OWNING module's permission object", () => {
    // Not a private vocabulary: these are Email's, WhatsApp's and
    // Calling's own object names, so an analysis reader can never see
    // more than they could in those modules directly.
    expect(CONVERSATION_SUBJECT_PERMISSION_OBJECTS).toEqual({
      email_thread: "email_thread",
      whatsapp_conversation: "whatsapp_conversation",
      call: "call",
    })
  })

  test("permission contexts name this module's own objects", () => {
    const ctx = makeServiceContext({ role: "member" })
    expect(conversationPermission(ctx, "read")).toMatchObject({
      object: CONVERSATION_ANALYSIS_OBJECT,
      action: "read",
      role: "member",
    })
    expect(conversationPermission(ctx, "create", CALL_TRANSCRIPT_OBJECT)).toMatchObject({
      object: "call_transcript",
      action: "create",
    })
    expect(conversationSubjectPermission(ctx, "call")).toMatchObject({
      object: "call",
      action: "read",
    })
  })

  test("an unknown role is treated as a viewer, never as an owner", () => {
    const ctx = makeServiceContext({ role: "definitely-not-a-role" })
    expect(conversationPermission(ctx, "read").role).toBe("definitely-not-a-role")
    // `read` sits at viewer rank, so an unknown role still reads …
    expect(canReadConversationSubjectType(ctx, "email_thread")).toBe(true)
    // … but a context with no actor is refused outright.
    const anonymous = makeServiceContext({ actorId: "" })
    expect(canReadConversationSubjectType(anonymous, "email_thread")).toBe(false)
    expect(readableConversationSubjectTypes(anonymous, registryFor("email_thread"))).toEqual([])
  })

  test("only subject types this deployment can RESOLVE are readable", () => {
    const ctx = makeServiceContext({ role: "owner" })
    // WhatsApp and Calling are not wired here. An analysis of one could
    // not have its visibility re-checked, so it is withheld — not
    // trusted — even from an owner.
    expect(readableConversationSubjectTypes(ctx, registryFor("email_thread"))).toEqual([
      "email_thread",
    ])
    expect(readableConversationSubjectTypes(ctx, registryFor())).toEqual([])
  })

  test("a requested subject type narrows the result, it never widens it", () => {
    const ctx = makeServiceContext({ role: "owner" })
    const registry = registryFor("email_thread", "call")
    expect(readableConversationSubjectTypes(ctx, registry)).toEqual(["email_thread", "call"])
    expect(readableConversationSubjectTypes(ctx, registry, "call")).toEqual(["call"])
    // Asking for a type with no source gets nothing, not everything.
    expect(readableConversationSubjectTypes(ctx, registry, "whatsapp_conversation")).toEqual([])
  })

  test("the registry reports what it has, and a later source wins", () => {
    const first = createConversationSource("call", {
      read: async () => null,
      filterReadable: async () => [],
    })
    const second = createConversationSource("call", {
      read: async () => null,
      filterReadable: async () => ["x"],
    })
    const registry = createConversationSourceRegistry([first, second])
    expect(registry.subjectTypes()).toEqual(["call"])
    expect(registry.get("call")).toBe(second)
    expect(registry.get("email_thread")).toBeNull()
  })

  test("a source binds its subject type onto whatever the reader returned", async () => {
    const source = createConversationSource("email_thread", {
      read: async () => ({
        title: "Renewal",
        turns: [{ speaker: "Ada", at: null, text: "hi" }],
        participants: ["Ada"],
        occurredAt: null,
      }),
      filterReadable: async (_ctx, ids) => [...ids],
    })
    const ctx = makeServiceContext()
    expect(await source.load(ctx, "t1")).toMatchObject({
      subjectType: "email_thread",
      subjectId: "t1",
      title: "Renewal",
    })
    // An empty page never reaches the owning module.
    expect(await source.filterReadable(ctx, [])).toEqual([])
  })
})
