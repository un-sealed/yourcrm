import { describe, expect, test } from "bun:test"
import {
  emailAncestorIds,
  emailParticipantKey,
  normalizeEmailAddress,
  normalizeEmailMessageId,
  normalizeEmailSubject,
  parseEmailReferenceChain,
  resolveEmailThread,
} from "./threading"
import type { EmailAncestorMatchRecord, EmailThreadLookupPort } from "./threading"

const WS = "ws_email_threading"

/**
 * Hermetic lookup port: the two reads the resolver makes, over arrays. It
 * mirrors what `email-repository.ts` does in SQL — match on exact
 * (normalised) Message-IDs, and on the frozen subject+participant key pair.
 */
function makeLookup(
  messages: { messageId: string; threadId: string }[] = [],
  threads: {
    id: string
    normalizedSubject: string
    participantKey: string
    lastMessageAt?: Date
  }[] = [],
) {
  const calls = { byMessageIds: 0, byMatch: 0 }
  const lookup: EmailThreadLookupPort = {
    findThreadIdsByMessageIds: async (workspaceId, ids) => {
      calls.byMessageIds += 1
      if (workspaceId !== WS) return []
      const out: EmailAncestorMatchRecord[] = []
      for (const message of messages) {
        if (ids.includes(message.messageId)) out.push({ ...message })
      }
      return out
    },
    findThreadByMatch: async (workspaceId, match) => {
      calls.byMatch += 1
      if (workspaceId !== WS) return null
      const found = threads.find(
        (thread) =>
          thread.normalizedSubject === match.normalizedSubject &&
          thread.participantKey === match.participantKey &&
          (!match.activeSince ||
            (thread.lastMessageAt ?? new Date(0)).getTime() >= match.activeSince.getTime()),
      )
      return found ? { id: found.id } : null
    },
  }
  return { lookup, calls, messages, threads }
}

describe("email/threading/normalisation", () => {
  test("message ids lose angle brackets, whitespace and case", () => {
    expect(normalizeEmailMessageId(" <ABC.123@Example.COM> ")).toBe("abc.123@example.com")
    expect(normalizeEmailMessageId("abc@example.com")).toBe("abc@example.com")
  })

  test("empty-ish message ids normalise to null", () => {
    for (const value of ["", "   ", "<>", null, undefined]) {
      expect(normalizeEmailMessageId(value)).toBeNull()
    }
  })

  test("reference chains parse from a raw header, oldest first, deduped", () => {
    const header = "<a@x.com> <B@x.com>\r\n\t<a@x.com> <c@x.com>"
    expect(parseEmailReferenceChain(header)).toEqual(["a@x.com", "b@x.com", "c@x.com"])
  })

  test("reference chains also accept a pre-split array", () => {
    expect(parseEmailReferenceChain(["<A@x.com>", "b@x.com"])).toEqual(["a@x.com", "b@x.com"])
    expect(parseEmailReferenceChain(null)).toEqual([])
  })

  test("subjects lose stacked reply and forward prefixes", () => {
    expect(normalizeEmailSubject("Re: Fwd:  RE: Q3   Budget ")).toBe("q3 budget")
    expect(normalizeEmailSubject("Re[2]: Q3 Budget")).toBe("q3 budget")
    expect(normalizeEmailSubject("AW: WG: Angebot")).toBe("angebot")
  })

  test("a prefix-only subject normalises to empty, which disables fallback", () => {
    expect(normalizeEmailSubject("Re:")).toBe("")
    expect(normalizeEmailSubject(null)).toBe("")
  })

  test("participant keys ignore order, case and duplicates", () => {
    const a = emailParticipantKey(["Ada@Example.com", "bob@example.com"])
    const b = emailParticipantKey(["bob@example.com", "ada@example.com", "ADA@example.com"])
    expect(a).toBe(b)
    expect(a).toHaveLength(64)
  })

  test("participant keys differ for different address sets", () => {
    expect(emailParticipantKey(["ada@example.com"])).not.toBe(
      emailParticipantKey(["bob@example.com"]),
    )
  })

  test("an empty or junk address set yields the empty sentinel", () => {
    expect(emailParticipantKey([])).toBe("")
    expect(emailParticipantKey([null, undefined, "   ", "not-an-address"])).toBe("")
  })

  test("addresses normalise, non-addresses do not", () => {
    expect(normalizeEmailAddress(" Ada@Example.COM ")).toBe("ada@example.com")
    expect(normalizeEmailAddress("nope")).toBeNull()
  })

  test("ancestors are ordered nearest-first and deduplicated", () => {
    expect(
      emailAncestorIds({ inReplyTo: "<b@x.com>", references: ["<root@x.com>", "<b@x.com>"] }),
    ).toEqual(["b@x.com", "root@x.com"])
  })
})

describe("email/threading/resolution", () => {
  test("a 3-message reply chain lands in one thread", async () => {
    // m1 starts the thread; m2 replies to m1; m3 replies to m2 carrying the
    // full References chain — the shape a real mail client produces.
    const stored: { messageId: string; threadId: string }[] = []
    const { lookup } = makeLookup(stored)

    const first = await resolveEmailThread(lookup, {
      workspaceId: WS,
      subject: "Q3 Budget",
      addresses: ["ada@example.com", "bob@example.com"],
    })
    expect(first.threadId).toBeNull()
    expect(first.reason).toBe("new")
    stored.push({ messageId: "m1@example.com", threadId: "thread-1" })

    const second = await resolveEmailThread(lookup, {
      workspaceId: WS,
      subject: "Re: Q3 Budget",
      inReplyTo: "<m1@example.com>",
      references: "<m1@example.com>",
      addresses: ["bob@example.com", "ada@example.com"],
    })
    expect(second.threadId).toBe("thread-1")
    expect(second.reason).toBe("reference")
    stored.push({ messageId: "m2@example.com", threadId: "thread-1" })

    const third = await resolveEmailThread(lookup, {
      workspaceId: WS,
      // Subject rewritten on purpose: only the headers should decide.
      subject: "Q3 Budget — final numbers",
      inReplyTo: "<m2@example.com>",
      references: "<m1@example.com> <m2@example.com>",
      addresses: ["ada@example.com", "bob@example.com", "carol@example.com"],
    })
    expect(third.threadId).toBe("thread-1")
    expect(third.reason).toBe("reference")
    expect(third.matchedAncestorId).toBe("m2@example.com")
  })

  test("two unrelated messages with the same subject do NOT share a thread", async () => {
    // Same subject line, different people. Subject alone must never merge.
    const participantKey = emailParticipantKey(["sales@acme.test", "ada@example.com"])
    const { lookup } = makeLookup(
      [],
      [
        {
          id: "thread-acme",
          normalizedSubject: "invoice",
          participantKey,
          lastMessageAt: new Date(),
        },
      ],
    )

    const sameParticipants = await resolveEmailThread(lookup, {
      workspaceId: WS,
      subject: "Re: Invoice",
      addresses: ["ada@example.com", "sales@acme.test"],
    })
    expect(sameParticipants.threadId).toBe("thread-acme")
    expect(sameParticipants.reason).toBe("subject")

    const unrelated = await resolveEmailThread(lookup, {
      workspaceId: WS,
      subject: "Invoice",
      addresses: ["zoe@other.test", "billing@other.test"],
    })
    expect(unrelated.threadId).toBeNull()
    expect(unrelated.reason).toBe("new")
  })

  test("a reference hit beats a subject hit", async () => {
    const participantKey = emailParticipantKey(["ada@example.com", "bob@example.com"])
    const { lookup, calls } = makeLookup(
      [{ messageId: "m1@example.com", threadId: "thread-by-reference" }],
      [
        {
          id: "thread-by-subject",
          normalizedSubject: "q3 budget",
          participantKey,
          lastMessageAt: new Date(),
        },
      ],
    )
    const resolved = await resolveEmailThread(lookup, {
      workspaceId: WS,
      subject: "Re: Q3 Budget",
      inReplyTo: "m1@example.com",
      addresses: ["ada@example.com", "bob@example.com"],
    })
    expect(resolved.threadId).toBe("thread-by-reference")
    expect(resolved.reason).toBe("reference")
    // The fallback query is never even issued once the chain matched.
    expect(calls.byMatch).toBe(0)
  })

  test("the nearest ancestor wins when the chain spans two threads", async () => {
    // Forward-then-reply: the References root belongs to an older thread,
    // In-Reply-To points at the current one. The immediate parent must win.
    const { lookup } = makeLookup([
      { messageId: "root@example.com", threadId: "thread-old" },
      { messageId: "parent@example.com", threadId: "thread-current" },
    ])
    const resolved = await resolveEmailThread(lookup, {
      workspaceId: WS,
      subject: "Re: shared",
      inReplyTo: "<parent@example.com>",
      references: "<root@example.com> <parent@example.com>",
      addresses: ["ada@example.com"],
    })
    expect(resolved.threadId).toBe("thread-current")
    expect(resolved.matchedAncestorId).toBe("parent@example.com")
  })

  test("references still match when In-Reply-To was dropped", async () => {
    const { lookup } = makeLookup([{ messageId: "root@example.com", threadId: "thread-1" }])
    const resolved = await resolveEmailThread(lookup, {
      workspaceId: WS,
      subject: "Re: hello",
      references: ["<root@example.com>"],
      addresses: ["ada@example.com"],
    })
    expect(resolved.threadId).toBe("thread-1")
    expect(resolved.reason).toBe("reference")
  })

  test("an unknown ancestor falls through to the subject fallback", async () => {
    const participantKey = emailParticipantKey(["ada@example.com", "bob@example.com"])
    const { lookup } = makeLookup(
      [],
      [
        {
          id: "thread-1",
          normalizedSubject: "q3 budget",
          participantKey,
          lastMessageAt: new Date(),
        },
      ],
    )
    const resolved = await resolveEmailThread(lookup, {
      workspaceId: WS,
      subject: "Re: Q3 Budget",
      inReplyTo: "<never-seen@example.com>",
      addresses: ["bob@example.com", "ada@example.com"],
    })
    expect(resolved.threadId).toBe("thread-1")
    expect(resolved.reason).toBe("subject")
  })

  test("a subject-less message never merges into another subject-less thread", async () => {
    const participantKey = emailParticipantKey(["ada@example.com"])
    const { lookup, calls } = makeLookup(
      [],
      [{ id: "thread-blank", normalizedSubject: "", participantKey, lastMessageAt: new Date() }],
    )
    const resolved = await resolveEmailThread(lookup, {
      workspaceId: WS,
      subject: "   ",
      addresses: ["ada@example.com"],
    })
    expect(resolved.threadId).toBeNull()
    expect(calls.byMatch).toBe(0)
  })

  test("the fallback window keeps a stale thread from swallowing a new one", async () => {
    const participantKey = emailParticipantKey(["ada@example.com", "billing@acme.test"])
    const twoYearsAgo = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000)
    const { lookup } = makeLookup(
      [],
      [
        {
          id: "thread-stale",
          normalizedSubject: "invoice",
          participantKey,
          lastMessageAt: twoYearsAgo,
        },
      ],
    )
    const bounded = await resolveEmailThread(lookup, {
      workspaceId: WS,
      subject: "Invoice",
      addresses: ["ada@example.com", "billing@acme.test"],
      activeSince: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    })
    expect(bounded.threadId).toBeNull()

    const unbounded = await resolveEmailThread(lookup, {
      workspaceId: WS,
      subject: "Invoice",
      addresses: ["ada@example.com", "billing@acme.test"],
      activeSince: null,
    })
    expect(unbounded.threadId).toBe("thread-stale")
  })

  test("threads never match across workspaces", async () => {
    const { lookup } = makeLookup([{ messageId: "m1@example.com", threadId: "thread-1" }])
    const resolved = await resolveEmailThread(lookup, {
      workspaceId: "ws_other",
      subject: "Re: hi",
      inReplyTo: "m1@example.com",
      addresses: ["ada@example.com"],
    })
    expect(resolved.threadId).toBeNull()
  })
})
