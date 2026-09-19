import { beforeEach, describe, expect, test } from "bun:test"
import { createStore, expectDenied, makeBaseRecord, makeServiceContext } from "@yourcrm/testing"
import type { BaseRecord, ServiceContext } from "@yourcrm/validation"
import {
  createStubAiProvider,
  type StubAiScriptStep,
} from "../ai-assistant/providers/stub-ai-provider"
import type { AiActionProposalPort, AiActionRequestRecord } from "../ai-governance/types"
import {
  CONVERSATION_ANALYSIS_MAX_OUTPUT_TOKENS,
  CONVERSATION_ANALYSIS_MAX_SOURCE_CHARS,
} from "./bounds"
import { containsConversationContent } from "./redaction"
import {
  createConversationSource,
  createConversationSourceRegistry,
  type ConversationSubjectReading,
} from "./sources"
import {
  createConversationIntelligenceService,
  ConversationActionItemNotFoundError,
  ConversationAnalysisFailedError,
  ConversationAnalysisNotFoundError,
  ConversationAnalysisQueueUnavailableError,
  ConversationGovernanceUnavailableError,
  ConversationSourceEmptyError,
  ConversationSourceUnavailableError,
  CONVERSATION_ACTION_ITEM_OBJECT_TYPE,
} from "./service"
import type {
  CallTranscriptInsert,
  CallTranscriptRecord,
  ConversationAnalysisInsert,
  ConversationAnalysisJob,
  ConversationAnalysisRecord,
  ConversationIntelligenceAuditInput,
  ConversationIntelligenceStore,
  ConversationSubjectType,
} from "./types"

/**
 * Hermetic service tests (`docs/conventions.md`): the deterministic stub
 * provider, in-memory stores and fake source adapters — no network, no
 * key, no Postgres, no BullMQ.
 *
 * The four named properties each have a `describe` block below. Anything
 * else here exists to make those four believable.
 *
 * Note what the stub provider proves on its own: it satisfies
 * `AiProvider` from `@yourcrm/ai` by structure, which is why this module
 * could import the real port instead of mirroring it.
 */

const WORKSPACE = "ws_ci"
const THREAD = "thread_northwind"

/** A conversation long enough that redaction has something to bite on. */
const TRANSCRIPT_TURNS = [
  "Maria Sanchez: Hello, I'm calling about invoice 4451-A for the Halifax site.",
  "Rep: I can see it — the balance is £12,400 and it went out on the 3rd of September.",
  "Maria Sanchez: My husband is in hospital this month, so I need to move the payment to the 20th.",
  "Rep: Understood. I'll note the new date and send written confirmation today.",
]

type StoredAnalysis = BaseRecord & Record<string, unknown>
type StoredTranscript = BaseRecord & Record<string, unknown>

type Harness = {
  service: ReturnType<typeof createConversationIntelligenceService>
  provider: ReturnType<typeof createStubAiProvider>
  audits: ConversationIntelligenceAuditInput[]
  jobs: ConversationAnalysisJob[]
  proposals: { ctx: ServiceContext; input: unknown }[]
  /** Anything a silent write would have to touch. Must stay empty. */
  crmWrites: { object: string; payload: unknown }[]
  store: ConversationIntelligenceStore
  analyses: ReturnType<typeof createStore<StoredAnalysis>>
  /** Actors allowed to READ the thread, i.e. the source's record gate. */
  readers: Set<string>
  turns: string[]
}

function makeStore(
  analyses: ReturnType<typeof createStore<StoredAnalysis>>,
  transcripts: ReturnType<typeof createStore<StoredTranscript>>,
): ConversationIntelligenceStore {
  let sequence = 0
  return {
    listAnalyses: async (workspaceId, query, subjectTypes) => {
      const limit = query.limit ?? 25
      const rows = analyses
        .list(workspaceId)
        .filter((row) => subjectTypes.includes(row.subjectType as ConversationSubjectType))
        .filter((row) => query.subjectId === undefined || row.subjectId === query.subjectId)
        .filter(
          (row) => query.analysisType === undefined || row.analysisType === query.analysisType,
        )
        .filter((row) => query.status === undefined || row.status === query.status)
        .sort((a, b) => Number(b.sequence) - Number(a.sequence))
      return {
        data: rows.slice(0, limit) as unknown as ConversationAnalysisRecord[],
        pagination: { nextCursor: null, limit },
      }
    },
    findAnalysis: async (workspaceId, id) =>
      analyses.get(id, workspaceId) as unknown as ConversationAnalysisRecord | null,
    createAnalysis: async (workspaceId, input: ConversationAnalysisInsert, actorId) => {
      sequence += 1
      return analyses.insert({
        ...makeBaseRecord({ workspaceId }),
        ...input,
        requestedBy: input.requestedBy ?? actorId ?? null,
        sequence,
      }) as unknown as ConversationAnalysisRecord
    },
    updateAnalysis: async (workspaceId, id, patch) =>
      analyses.update(id, workspaceId, {
        ...patch,
      } as Partial<StoredAnalysis>) as unknown as ConversationAnalysisRecord | null,
    listTranscripts: async (workspaceId, subjectType, subjectId) =>
      transcripts
        .list(workspaceId)
        .filter((row) => row.subjectType === subjectType && row.subjectId === subjectId)
        .reverse() as unknown as CallTranscriptRecord[],
    findTranscript: async (workspaceId, id) =>
      transcripts.get(id, workspaceId) as unknown as CallTranscriptRecord | null,
    findTranscriptByExternalId: async (workspaceId, externalId) =>
      (transcripts.list(workspaceId).find((row) => row.externalId === externalId) ??
        null) as unknown as CallTranscriptRecord | null,
    createTranscript: async (workspaceId, input: CallTranscriptInsert, actorId) =>
      transcripts.insert({
        ...makeBaseRecord({ workspaceId }),
        ...input,
        createdBy: actorId,
      }) as unknown as CallTranscriptRecord,
  }
}

type HarnessOptions = {
  script?: StubAiScriptStep[]
  /**
   * Force the provider's `finishReason`. The stub does not script it and
   * this module must not change another module's file, so the stub is
   * wrapped rather than edited.
   */
  finishReason?: "stop" | "length"
  turns?: string[]
  /** Register the email source at all. */
  withSource?: boolean
  withQueue?: boolean
  withGovernance?: boolean
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const analyses = createStore<StoredAnalysis>()
  const transcripts = createStore<StoredTranscript>()
  const audits: ConversationIntelligenceAuditInput[] = []
  const jobs: ConversationAnalysisJob[] = []
  const proposals: { ctx: ServiceContext; input: unknown }[] = []
  const crmWrites: { object: string; payload: unknown }[] = []
  const readers = new Set<string>()
  const turns = options.turns ?? TRANSCRIPT_TURNS
  const store = makeStore(analyses, transcripts)
  const provider = createStubAiProvider({ script: options.script ?? [] })
  const reason = options.finishReason
  const effectiveProvider =
    reason === undefined
      ? provider
      : {
          ...provider,
          complete: async (
            messages: Parameters<typeof provider.complete>[0],
            opts?: Parameters<typeof provider.complete>[1],
          ) => ({
            ...(await provider.complete(messages, opts)),
            finishReason: reason,
          }),
        }

  /**
   * The Email module, as this test sees it: a record-level gate exactly
   * like `EmailService.getThread` running `requirePermission` plus the
   * thread's own visibility. `readers` is the set of actors who may see
   * the thread; everyone else gets `null`, the same answer a missing
   * thread gives.
   */
  const reading = (): ConversationSubjectReading => ({
    title: "Renewal for Northwind",
    turns: turns.map((line, index) => {
      const [speaker = "Unknown", ...rest] = line.split(": ")
      return {
        speaker,
        at: `2026-09-18T09:${String(index).padStart(2, "0")}:00.000Z`,
        text: rest.join(": "),
      }
    }),
    participants: ["Maria Sanchez", "Rep"],
    occurredAt: "2026-09-18T09:00:00.000Z",
  })

  const emailSource = createConversationSource("email_thread", {
    read: async (ctx, subjectId) =>
      subjectId === THREAD && readers.has(ctx.actorId) ? reading() : null,
    filterReadable: async (ctx, ids) =>
      readers.has(ctx.actorId) ? ids.filter((id) => id === THREAD) : [],
  })

  const governance: AiActionProposalPort = {
    requestAction: async (ctx, input) => {
      proposals.push({ ctx, input })
      // A real approval queue parks it. It does NOT apply it, and this
      // fake deliberately never calls anything that could write.
      const request = {
        id: "req_1",
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        objectType: CONVERSATION_ACTION_ITEM_OBJECT_TYPE,
        action: "create",
        status: "pending",
      } satisfies AiActionRequestRecord
      return { request, mode: "require_approval", applied: false }
    },
  }

  const service = createConversationIntelligenceService({
    store,
    sources: createConversationSourceRegistry(options.withSource === false ? [] : [emailSource]),
    provider: effectiveProvider,
    audit: async (input) => {
      audits.push(input)
    },
    events: { emit: async () => undefined },
    ...(options.withQueue === false
      ? {}
      : {
          queue: {
            enqueueConversationAnalysis: async (job) => {
              jobs.push(job)
            },
          },
        }),
    ...(options.withGovernance === false ? {} : { governance }),
  })

  return {
    service,
    provider,
    audits,
    jobs,
    proposals,
    crmWrites,
    store,
    analyses,
    readers,
    turns,
  }
}

function ctxFor(actorId: string, role = "member"): ServiceContext {
  return makeServiceContext({ workspaceId: WORKSPACE, actorId, role })
}

const ANALYSE_SUMMARY = {
  subjectType: "email_thread" as const,
  subjectId: THREAD,
  types: ["summary" as const],
}

const SUMMARY_SCRIPT: StubAiScriptStep[] = [
  {
    text: '{"summary":"Maria asked to move the payment date.","highlights":["New date: the 20th"]}',
  },
]

describe("conversation-intelligence/service", () => {
  let harness: Harness

  beforeEach(() => {
    harness = makeHarness({ script: [...SUMMARY_SCRIPT] })
    harness.readers.add("u_owner")
  })

  /* ------------------------------------------------------------------ */
  /* PROPERTY 1 — permission inheritance                                 */
  /* ------------------------------------------------------------------ */

  describe("property/permission inheritance", () => {
    test("a user who cannot read the email thread cannot read its summary", async () => {
      const owner = ctxFor("u_owner")
      const [analysis] = await harness.service.analyzeConversation(owner, ANALYSE_SUMMARY)
      expect(analysis?.status).toBe("succeeded")

      // Same workspace, same role, same everything — except that the
      // Email module does not show them this thread.
      const outsider = ctxFor("u_outsider")
      expect(harness.readers.has("u_outsider")).toBe(false)

      await expect(
        harness.service.getAnalysis(outsider, String(analysis?.id)),
      ).rejects.toBeInstanceOf(ConversationAnalysisNotFoundError)

      // And it is not merely hidden on the detail route: it never appears.
      const page = await harness.service.listAnalyses(outsider, {})
      expect(page.data).toEqual([])
      expect(await harness.service.listActionItems(owner, String(analysis?.id))).toEqual([])
      await expect(
        harness.service.listActionItems(outsider, String(analysis?.id)),
      ).rejects.toBeInstanceOf(ConversationAnalysisNotFoundError)

      // The owner still sees it, so the test is not passing vacuously.
      const ownerPage = await harness.service.listAnalyses(owner, {})
      expect(ownerPage.data.map((row) => row.id)).toEqual([String(analysis?.id)])
    })

    test("losing access to the thread retroactively hides the analysis", async () => {
      const owner = ctxFor("u_owner")
      const [analysis] = await harness.service.analyzeConversation(owner, ANALYSE_SUMMARY)
      const id = String(analysis?.id)
      expect((await harness.service.getAnalysis(owner, id)).analysis.id).toBe(id)

      // Visibility is re-resolved on every read, never cached on the row.
      harness.readers.delete("u_owner")
      await expect(harness.service.getAnalysis(owner, id)).rejects.toBeInstanceOf(
        ConversationAnalysisNotFoundError,
      )
      expect((await harness.service.listAnalyses(owner, {})).data).toEqual([])
    })

    test("analysing a conversation you cannot read is refused before any token is spent", async () => {
      const outsider = ctxFor("u_outsider")
      await expect(
        harness.service.analyzeConversation(outsider, ANALYSE_SUMMARY),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
      expect(harness.provider.calls.length).toBe(0)
      expect(harness.analyses.list(WORKSPACE)).toEqual([])
    })

    test("a hidden thread and a missing thread are the same answer", async () => {
      const owner = ctxFor("u_owner")
      const hidden = await harness.service
        .analyzeConversation(ctxFor("u_outsider"), ANALYSE_SUMMARY)
        .catch((err: unknown) => err)
      const missing = await harness.service
        .analyzeConversation(owner, { ...ANALYSE_SUMMARY, subjectId: "thread_nope" })
        .catch((err: unknown) => err)
      expect((hidden as Error).name).toBe((missing as Error).name)
      expect((hidden as { code: string }).code).toBe((missing as { code: string }).code)
    })

    test("requirePermission runs first — an actorless context never reaches a source", async () => {
      const anonymous = makeServiceContext({ workspaceId: WORKSPACE, actorId: "", role: "owner" })
      await expectDenied(() => harness.service.listAnalyses(anonymous, {}))
      await expectDenied(() => harness.service.analyzeConversation(anonymous, ANALYSE_SUMMARY))
      await expectDenied(() => harness.service.getAnalysis(anonymous, "any"))
      await expectDenied(() => harness.service.listTranscripts(anonymous, "call", "call_1"))
      await expectDenied(() =>
        harness.service.ingestCallTranscript(anonymous, {
          subjectId: "call_1",
          source: "manual",
          text: "hello",
        }),
      )
      expect(harness.provider.calls.length).toBe(0)
    })

    test("a subject type with no registered source cannot be analysed at all", async () => {
      const bare = makeHarness({ withSource: false })
      bare.readers.add("u_owner")
      await expect(
        bare.service.analyzeConversation(ctxFor("u_owner"), ANALYSE_SUMMARY),
      ).rejects.toBeInstanceOf(ConversationSourceUnavailableError)
      expect(bare.provider.calls.length).toBe(0)
    })
  })

  /* ------------------------------------------------------------------ */
  /* PROPERTY 2 — no silent writes                                       */
  /* ------------------------------------------------------------------ */

  describe("property/no silent writes", () => {
    const ACTION_SCRIPT: StubAiScriptStep[] = [
      {
        text: '{"items":[{"title":"Send written confirmation","owner":"Rep","dueDate":"2026-09-18"},{"title":"Call Maria on the 20th","owner":null,"dueDate":null}]}',
      },
    ]

    test("an extracted action item does NOT create a task", async () => {
      const h = makeHarness({ script: [...ACTION_SCRIPT] })
      h.readers.add("u_owner")
      const owner = ctxFor("u_owner")

      const [analysis] = await h.service.analyzeConversation(owner, {
        ...ANALYSE_SUMMARY,
        types: ["action_items"],
      })

      // Two items were extracted …
      const items = await h.service.listActionItems(owner, String(analysis?.id))
      expect(items.map((item) => item.title)).toEqual([
        "Send written confirmation",
        "Call Maria on the 20th",
      ])
      // … and nothing at all was written outside this module's own row.
      expect(h.crmWrites).toEqual([])
      expect(h.proposals).toEqual([])
      expect(h.audits.every((row) => row.object === "conversation_analysis")).toBe(true)
      expect(h.audits.some((row) => row.action.includes("create"))).toBe(false)
    })

    test("proposing an item parks a PENDING approval and still writes nothing", async () => {
      const h = makeHarness({ script: [...ACTION_SCRIPT] })
      h.readers.add("u_owner")
      const owner = ctxFor("u_owner")
      const [analysis] = await h.service.analyzeConversation(owner, {
        ...ANALYSE_SUMMARY,
        types: ["action_items"],
      })

      const outcome = await h.service.proposeConversationActionItem(owner, String(analysis?.id), {
        itemIndex: 0,
      })

      expect(h.proposals.length).toBe(1)
      expect(h.proposals[0]?.input).toMatchObject({
        objectType: "task",
        action: "create",
        after: { title: "Send written confirmation" },
      })
      // The proposer is an AGENT, so spec 38 refuses to let it decide.
      expect(h.proposals[0]?.ctx).toMatchObject({
        actorType: "agent",
        agentId: "conversation-intelligence",
      })
      expect(outcome.request.status).toBe("pending")
      expect(outcome.applied).toBe(false)
      expect(h.crmWrites).toEqual([])
    })

    test("a proposal carries a rationale and the run that produced it", async () => {
      const h = makeHarness({ script: [...ACTION_SCRIPT] })
      h.readers.add("u_owner")
      const owner = ctxFor("u_owner")
      const [analysis] = await h.service.analyzeConversation(owner, {
        ...ANALYSE_SUMMARY,
        types: ["action_items"],
      })
      await h.service.proposeConversationActionItem(owner, String(analysis?.id), { itemIndex: 1 })
      expect(h.proposals[0]?.input).toMatchObject({
        runId: String(analysis?.runId),
        agentId: "conversation-intelligence",
      })
      expect(String((h.proposals[0]?.input as { rationale: string }).rationale)).toContain(
        "until this is approved",
      )
    })

    test("with no approval queue wired the proposal is refused, not written", async () => {
      const h = makeHarness({ script: [...ACTION_SCRIPT], withGovernance: false })
      h.readers.add("u_owner")
      const owner = ctxFor("u_owner")
      const [analysis] = await h.service.analyzeConversation(owner, {
        ...ANALYSE_SUMMARY,
        types: ["action_items"],
      })
      await expect(
        h.service.proposeConversationActionItem(owner, String(analysis?.id), { itemIndex: 0 }),
      ).rejects.toBeInstanceOf(ConversationGovernanceUnavailableError)
      expect(h.crmWrites).toEqual([])
    })

    test("an item index that does not exist cannot be proposed", async () => {
      const h = makeHarness({ script: [...ACTION_SCRIPT] })
      h.readers.add("u_owner")
      const owner = ctxFor("u_owner")
      const [analysis] = await h.service.analyzeConversation(owner, {
        ...ANALYSE_SUMMARY,
        types: ["action_items"],
      })
      await expect(
        h.service.proposeConversationActionItem(owner, String(analysis?.id), { itemIndex: 9 }),
      ).rejects.toBeInstanceOf(ConversationActionItemNotFoundError)
      expect(h.proposals).toEqual([])
    })

    test("a user who cannot read the thread cannot propose from its analysis", async () => {
      const h = makeHarness({ script: [...ACTION_SCRIPT] })
      h.readers.add("u_owner")
      const [analysis] = await h.service.analyzeConversation(ctxFor("u_owner"), {
        ...ANALYSE_SUMMARY,
        types: ["action_items"],
      })
      await expect(
        h.service.proposeConversationActionItem(ctxFor("u_outsider"), String(analysis?.id), {
          itemIndex: 0,
        }),
      ).rejects.toBeInstanceOf(ConversationAnalysisNotFoundError)
      expect(h.proposals).toEqual([])
    })
  })

  /* ------------------------------------------------------------------ */
  /* PROPERTY 3 — bounded cost                                           */
  /* ------------------------------------------------------------------ */

  describe("property/bounded cost", () => {
    /** ~2 million characters: eight hours of speech. */
    const ENORMOUS = Array.from(
      { length: 4_000 },
      (_, i) => `Speaker ${String(i % 2)}: ${"conversation filler ".repeat(25)}`,
    )

    test("an enormous transcript does not produce an unbounded request", async () => {
      const h = makeHarness({ script: [...SUMMARY_SCRIPT], turns: ENORMOUS })
      h.readers.add("u_owner")
      const [analysis] = await h.service.analyzeConversation(ctxFor("u_owner"), ANALYSE_SUMMARY)

      const call = h.provider.calls[0]
      const promptChars = (call?.messages ?? []).reduce(
        (total, message) => total + message.content.length,
        0,
      )
      // The source really was enormous …
      expect(Number(analysis?.sourceChars)).toBeGreaterThan(1_500_000)
      // … and the request was not. Cap + a fixed system prompt and header.
      expect(promptChars).toBeLessThan(CONVERSATION_ANALYSIS_MAX_SOURCE_CHARS + 2_000)
      expect(Number(analysis?.analysedChars)).toBeLessThanOrEqual(
        CONVERSATION_ANALYSIS_MAX_SOURCE_CHARS,
      )
      expect(analysis?.truncated).toBe(true)
    })

    test("the completion is capped too, so the answer cannot run away", async () => {
      const h = makeHarness({ script: [...SUMMARY_SCRIPT], turns: ENORMOUS })
      h.readers.add("u_owner")
      await h.service.analyzeConversation(ctxFor("u_owner"), ANALYSE_SUMMARY)
      expect(h.provider.calls[0]?.options?.maxOutputTokens).toBe(
        CONVERSATION_ANALYSIS_MAX_OUTPUT_TOKENS,
      )
    })

    test("actual tokens used are recorded per analysis, from the provider", async () => {
      const h = makeHarness({
        script: [
          {
            text: '{"summary":"short"}',
            usage: { promptTokens: 5_912, completionTokens: 44, totalTokens: 5_956 },
            latencyMs: 812,
          },
        ],
        turns: ENORMOUS,
      })
      h.readers.add("u_owner")
      const [analysis] = await h.service.analyzeConversation(ctxFor("u_owner"), ANALYSE_SUMMARY)
      expect(analysis).toMatchObject({
        promptTokens: 5_912,
        completionTokens: 44,
        totalTokens: 5_956,
        latencyMs: 812,
        providerId: "stub",
        model: "stub-echo-1",
      })
      expect(String(analysis?.runId)).not.toBe("")
    })

    test("the same conversation twice sends byte-identical prompts", async () => {
      const h = makeHarness({ script: [...SUMMARY_SCRIPT, ...SUMMARY_SCRIPT], turns: ENORMOUS })
      h.readers.add("u_owner")
      const owner = ctxFor("u_owner")
      await h.service.analyzeConversation(owner, ANALYSE_SUMMARY)
      await h.service.analyzeConversation(owner, ANALYSE_SUMMARY)
      expect(h.provider.calls[0]?.messages).toEqual(h.provider.calls[1]?.messages ?? [])
    })

    test("one request cannot ask for more than the four analyses", async () => {
      const h = makeHarness({ script: Array.from({ length: 8 }, () => ({ text: "{}" })) })
      h.readers.add("u_owner")
      // Duplicates are rejected outright rather than silently deduplicated:
      // a duplicate would otherwise cost real money twice.
      await expect(
        h.service.analyzeConversation(ctxFor("u_owner"), {
          ...ANALYSE_SUMMARY,
          types: ["summary", "summary"],
        }),
      ).rejects.toThrow()
      expect(h.provider.calls.length).toBe(0)

      const rows = await h.service.analyzeConversation(ctxFor("u_owner"), {
        ...ANALYSE_SUMMARY,
        types: ["summary", "sentiment", "action_items", "key_topics"],
      })
      expect(rows.length).toBe(4)
      expect(h.provider.calls.length).toBe(4)
    })

    test("each analysis is its own run with its own tokens, not a shared pool", async () => {
      const h = makeHarness({
        script: [
          { text: '{"summary":"a"}', usage: { promptTokens: 100, completionTokens: 10 } },
          { text: '{"label":"neutral"}', usage: { promptTokens: 100, completionTokens: 4 } },
        ],
      })
      h.readers.add("u_owner")
      const rows = await h.service.analyzeConversation(ctxFor("u_owner"), {
        ...ANALYSE_SUMMARY,
        types: ["summary", "sentiment"],
      })
      expect(rows.map((row) => row.completionTokens)).toEqual([10, 4])
      expect(new Set(rows.map((row) => String(row.runId))).size).toBe(2)
    })

    test("an answer cut off by the output cap fails loudly instead of looking empty", async () => {
      // Found by a REAL provider run: a reasoning model spent its whole
      // output budget before emitting an answer, and the empty result
      // read like a confident "nothing to do" — on a thread with three
      // obvious commitments in it.
      const h = makeHarness({ script: [{ text: "" }], finishReason: "length" })
      h.readers.add("u_owner")
      await expect(
        h.service.analyzeConversation(ctxFor("u_owner"), {
          ...ANALYSE_SUMMARY,
          types: ["action_items"],
        }),
      ).rejects.toMatchObject({ code: "AI_PROVIDER_RESPONSE_TRUNCATED" })
      const [row] = h.analyses.list(WORKSPACE)
      expect(row?.status).toBe("failed")
      expect(row?.errorCode).toBe("AI_PROVIDER_RESPONSE_TRUNCATED")
    })

    test("a cut-off answer that still says something is kept, and flagged", async () => {
      const h = makeHarness({
        script: [{ text: '{"summary":"Maria asked to move the date."' }],
        finishReason: "length",
      })
      h.readers.add("u_owner")
      const [row] = await h.service.analyzeConversation(ctxFor("u_owner"), ANALYSE_SUMMARY)
      expect(row?.status).toBe("succeeded")
      expect(row?.errorCode).toBe("AI_PROVIDER_RESPONSE_TRUNCATED")
    })

    test("an empty conversation spends nothing at all", async () => {
      const h = makeHarness({ script: [...SUMMARY_SCRIPT], turns: [] })
      h.readers.add("u_owner")
      await expect(
        h.service.analyzeConversation(ctxFor("u_owner"), ANALYSE_SUMMARY),
      ).rejects.toBeInstanceOf(ConversationSourceEmptyError)
      expect(h.provider.calls.length).toBe(0)
      expect(h.analyses.list(WORKSPACE)).toEqual([])
    })
  })

  /* ------------------------------------------------------------------ */
  /* PROPERTY 4 — PII stays put                                          */
  /* ------------------------------------------------------------------ */

  describe("property/PII stays put", () => {
    function providerErrorQuotingTheTranscript(): Error {
      const quoted = TRANSCRIPT_TURNS.join("\n")
      const err = new Error(
        `400 invalid_request: the model rejected the input — "${quoted}" (context length exceeded)`,
      )
      Object.assign(err, { code: "AI_PROVIDER_INVALID_RESPONSE" })
      return err
    }

    test("an error carrying transcript text is redacted everywhere it lands", async () => {
      const h = makeHarness({ script: [{ error: providerErrorQuotingTheTranscript() }] })
      h.readers.add("u_owner")
      const owner = ctxFor("u_owner")
      const transcript = TRANSCRIPT_TURNS.join("\n")

      const thrown = await h.service
        .analyzeConversation(owner, ANALYSE_SUMMARY)
        .catch((err: unknown) => err)

      // 1. The error the caller sees.
      expect(thrown).toBeInstanceOf(ConversationAnalysisFailedError)
      const message = (thrown as Error).message
      expect(message).toContain("400 invalid_request")
      expect(message).not.toContain("Maria Sanchez")
      expect(message).not.toContain("hospital")
      expect(containsConversationContent(message, transcript)).toBe(false)

      // 2. The row that was stored.
      const [row] = h.analyses.list(WORKSPACE)
      expect(row?.status).toBe("failed")
      expect(row?.errorCode).toBe("AI_PROVIDER_INVALID_RESPONSE")
      expect(containsConversationContent(String(row?.errorMessage), transcript)).toBe(false)

      // 3. The audit trail — the widest audience of the three.
      expect(h.audits.length).toBeGreaterThan(0)
      for (const entry of h.audits) {
        expect(containsConversationContent(JSON.stringify(entry), transcript)).toBe(false)
      }
    })

    test("audit rows for an analysis carry metadata and nothing else", async () => {
      const owner = ctxFor("u_owner")
      const [analysis] = await harness.service.analyzeConversation(owner, ANALYSE_SUMMARY)
      const entry = harness.audits.find((row) => row.action === "analyze")
      expect(entry).toBeDefined()
      expect(entry?.source).toBe("ai")
      expect(entry?.recordId).toBe(String(analysis?.id))
      expect(Object.keys(entry?.after as Record<string, unknown>).sort()).toEqual([
        "analysedChars",
        "analysisId",
        "analysisType",
        "completionTokens",
        "latencyMs",
        "model",
        "outcome",
        "promptTokens",
        "providerId",
        "runId",
        "sourceChars",
        "status",
        "subjectId",
        "subjectType",
        "totalTokens",
        "truncated",
      ])
      // The model's own answer is stored on the row for the user — and is
      // deliberately absent from the audit payload.
      expect(JSON.stringify(entry?.after)).not.toContain("Maria")
      expect(JSON.stringify(analysis?.output)).toContain("payment date")
    })

    test("a transcript ingest audits its size, never its content", async () => {
      const owner = ctxFor("u_owner")
      harness.readers.add("u_owner")
      const secret = "Patient reference 99213 discussed at length with the family"
      await harness.service.ingestCallTranscript(owner, {
        subjectType: "email_thread",
        subjectId: THREAD,
        source: "manual",
        text: secret,
      })
      const entry = harness.audits.find((row) => row.action === "ingest")
      expect(entry?.object).toBe("call_transcript")
      expect(JSON.stringify(entry?.after)).not.toContain("99213")
      expect(entry?.after).toMatchObject({ charCount: secret.length, source: "manual" })
    })

    test("a proposal audits the item index, not the item text", async () => {
      const h = makeHarness({
        script: [{ text: '{"items":[{"title":"Call Maria Sanchez about the hospital dates"}]}' }],
      })
      h.readers.add("u_owner")
      const owner = ctxFor("u_owner")
      const [analysis] = await h.service.analyzeConversation(owner, {
        ...ANALYSE_SUMMARY,
        types: ["action_items"],
      })
      await h.service.proposeConversationActionItem(owner, String(analysis?.id), { itemIndex: 0 })
      const entry = h.audits.find((row) => row.action === "propose_action_item")
      expect(entry?.after).toMatchObject({ itemIndex: 0, itemCount: 1, requestStatus: "pending" })
      expect(JSON.stringify(entry?.after)).not.toContain("hospital")
    })
  })

  /* ------------------------------------------------------------------ */
  /* Queued path, transcripts, status                                    */
  /* ------------------------------------------------------------------ */

  describe("queued analysis", () => {
    test("queuing persists rows and calls no provider in the request path", async () => {
      const owner = ctxFor("u_owner")
      const rows = await harness.service.queueConversationAnalysis(owner, {
        ...ANALYSE_SUMMARY,
        types: ["summary", "sentiment"],
      })
      expect(rows.map((row) => row.status)).toEqual(["queued", "queued"])
      expect(harness.provider.calls.length).toBe(0)
      expect(harness.jobs.length).toBe(2)
    })

    test("a job carries ids and an actor, never conversation text", () => {
      return harness.service
        .queueConversationAnalysis(ctxFor("u_owner"), ANALYSE_SUMMARY)
        .then(() => {
          const job = harness.jobs[0]
          expect(Object.keys(job ?? {}).sort()).toEqual([
            "actorId",
            "analysisId",
            "analysisType",
            "correlationId",
            "subjectId",
            "subjectType",
            "workspaceId",
          ])
          expect(
            containsConversationContent(JSON.stringify(job), TRANSCRIPT_TURNS.join("\n")),
          ).toBe(false)
        })
    })

    test("the worker path re-checks permissions and is idempotent on retry", async () => {
      const owner = ctxFor("u_owner")
      const [queued] = await harness.service.queueConversationAnalysis(owner, ANALYSE_SUMMARY)
      const id = String(queued?.id)

      // An actor who lost access cannot make the worker run it for them.
      await expect(
        harness.service.runQueuedConversationAnalysis(ctxFor("u_outsider"), id),
      ).rejects.toBeInstanceOf(ConversationAnalysisNotFoundError)
      expect(harness.provider.calls.length).toBe(0)

      const done = await harness.service.runQueuedConversationAnalysis(owner, id)
      expect(done.status).toBe("succeeded")
      expect(harness.provider.calls.length).toBe(1)

      // BullMQ retried after the acknowledgement was lost: no second bill.
      const again = await harness.service.runQueuedConversationAnalysis(owner, id)
      expect(again.status).toBe("succeeded")
      expect(harness.provider.calls.length).toBe(1)
    })

    test("with no queue wired, queuing is refused rather than run inline", async () => {
      const h = makeHarness({ script: [...SUMMARY_SCRIPT], withQueue: false })
      h.readers.add("u_owner")
      await expect(
        h.service.queueConversationAnalysis(ctxFor("u_owner"), ANALYSE_SUMMARY),
      ).rejects.toBeInstanceOf(ConversationAnalysisQueueUnavailableError)
      expect(h.provider.calls.length).toBe(0)
    })
  })

  describe("transcripts", () => {
    test("a provider re-delivery is idempotent on the provider's own id", async () => {
      const owner = ctxFor("u_owner")
      const payload = {
        subjectType: "email_thread" as const,
        subjectId: THREAD,
        source: "provider" as const,
        providerId: "acme-notetaker",
        externalId: "acme_tr_7",
        segments: [{ speaker: "Ada", startMs: 0, text: "Hello" }],
      }
      const first = await harness.service.ingestCallTranscript(owner, payload)
      const second = await harness.service.ingestCallTranscript(owner, payload)
      expect(first.created).toBe(true)
      expect(second.created).toBe(false)
      expect(second.transcript.id).toBe(first.transcript.id)
    })

    test("a provider transcript must name its provider", async () => {
      await expect(
        harness.service.ingestCallTranscript(ctxFor("u_owner"), {
          subjectId: THREAD,
          source: "provider",
          text: "hello there everyone",
        }),
      ).rejects.toThrow()
    })

    test("text is derived from segments when only segments are sent", async () => {
      const { transcript } = await harness.service.ingestCallTranscript(ctxFor("u_owner"), {
        subjectType: "email_thread",
        subjectId: THREAD,
        source: "manual",
        segments: [
          { speaker: "Ada", text: "Shall we sign?" },
          { speaker: "Grace", text: "Send it over." },
        ],
      })
      expect(transcript.text).toBe("Ada: Shall we sign?\nGrace: Send it over.")
      expect(transcript.speakerCount).toBe(2)
    })

    test("a transcript cannot be attached to a conversation you cannot read", async () => {
      await expect(
        harness.service.ingestCallTranscript(ctxFor("u_outsider"), {
          subjectType: "email_thread",
          subjectId: THREAD,
          source: "manual",
          text: "trying to write into somebody else's thread",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
    })

    test("listing transcripts inherits the conversation's visibility", async () => {
      const owner = ctxFor("u_owner")
      await harness.service.ingestCallTranscript(owner, {
        subjectType: "email_thread",
        subjectId: THREAD,
        source: "manual",
        text: "a pasted transcript",
      })
      expect((await harness.service.listTranscripts(owner, "email_thread", THREAD)).length).toBe(1)
      await expect(
        harness.service.listTranscripts(ctxFor("u_outsider"), "email_thread", THREAD),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
    })
  })

  describe("status", () => {
    test("the status endpoint describes the limits without leaking a secret", () => {
      const status = harness.service.describeStatus(ctxFor("u_owner"))
      expect(status).toEqual({
        providerId: "stub",
        model: "stub-echo-1",
        maxSourceChars: CONVERSATION_ANALYSIS_MAX_SOURCE_CHARS,
        maxOutputTokens: CONVERSATION_ANALYSIS_MAX_OUTPUT_TOKENS,
        analysisTypes: ["summary", "sentiment", "action_items", "key_topics"],
        subjectTypes: ["email_thread"],
        queued: true,
      })
      // No credential, no base url, no header — only limits and names.
      expect(JSON.stringify(status)).not.toContain("apiKey")
    })

    test("every analysis of one conversation is listable from the conversation", async () => {
      const owner = ctxFor("u_owner")
      await harness.service.analyzeConversation(owner, ANALYSE_SUMMARY)
      const page = await harness.service.listAnalysesForSubject(owner, "email_thread", THREAD)
      expect(page.data.length).toBe(1)
      await expect(
        harness.service.listAnalysesForSubject(ctxFor("u_outsider"), "email_thread", THREAD),
      ).rejects.toMatchObject({ code: "NOT_FOUND" })
    })
  })
})
