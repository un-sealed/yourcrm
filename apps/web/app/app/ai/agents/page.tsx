"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Badge, Button, Dialog, EmptyState, ErrorState, Field, Skeleton, TextArea } from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  canEnableAiAgent,
  describeAiAgentRun,
  describeAiAgentTrigger,
  formatAiAgentTimestamp,
  AI_AGENT_RUN_STATUS_LABELS,
  AI_AGENT_RUN_STATUS_TONES,
  AI_AGENT_STATUS_TONES,
  type AiAgent,
  type AiAgentRun,
  type AiAgentRunsResponse,
  type AiAgentsResponse,
} from "./types"

/**
 * AI agents (spec 36, P0).
 *
 * What an operator needs from this page: which agents exist, what each
 * one is allowed to do, whether it is on, and what its runs cost. Every
 * control is a convenience — the server refuses a viewer's enable, runs
 * the agent as its owner with that owner's live role, and routes every
 * proposed change through the approval queue. The page's job is to be
 * honest about all three.
 */

export default function AiAgentsPage() {
  const [agents, setAgents] = useState<AiAgent[]>([])
  const [runs, setRuns] = useState<AiAgentRun[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [runTarget, setRunTarget] = useState<AiAgent | null>(null)
  const [task, setTask] = useState("")
  const [working, setWorking] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetchRaw<AiAgentsResponse>("/api/v1/ai/agents?limit=50")
      setAgents(res.data)
      setSelectedId((current) =>
        current !== null && res.data.some((agent) => agent.id === current)
          ? current
          : (res.data[0]?.id ?? null),
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your AI agents.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const loadRuns = useCallback(async (agentId: string) => {
    try {
      const res = await apiFetchRaw<AiAgentRunsResponse>(
        `/api/v1/ai/agents/${agentId}/runs?limit=20`,
      )
      setRuns(res.data)
    } catch {
      // The run history is secondary: a failure here must not blank the
      // page the operator came for.
      setRuns([])
    }
  }, [])

  useEffect(() => {
    if (selectedId === null) {
      setRuns([])
      return
    }
    void loadRuns(selectedId)
  }, [selectedId, loadRuns])

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  )

  const toggleStatus = async (agent: AiAgent) => {
    setWorking(true)
    setActionError(null)
    try {
      await apiFetch(`/api/v1/ai/agents/${agent.id}/status`, {
        method: "POST",
        body: { status: agent.status === "enabled" ? "disabled" : "enabled" },
      })
      await load()
    } catch (err) {
      setActionError(
        err instanceof ApiError ? err.message : "Could not change that agent's status.",
      )
    } finally {
      setWorking(false)
    }
  }

  const submitRun = async () => {
    if (runTarget === null) return
    setWorking(true)
    setActionError(null)
    try {
      await apiFetch(`/api/v1/ai/agents/${runTarget.id}/run`, {
        method: "POST",
        body: task.trim() === "" ? {} : { input: task.trim() },
      })
      setNotice(
        `Queued a run for ${runTarget.name}. Anything it wants to change will appear in AI approvals.`,
      )
      setRunTarget(null)
      setTask("")
      await loadRuns(runTarget.id)
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not queue that run.")
    } finally {
      setWorking(false)
    }
  }

  if (error !== null) {
    return <ErrorState message={error} onRetry={() => void load()} />
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">AI agents</h1>
          <p className="text-sm text-muted-foreground">
            An agent reads with its owner&apos;s permissions and can only propose changes — a person
            approves them in{" "}
            <Link className="underline" href="/app/ai/governance">
              AI approvals
            </Link>
            .
          </p>
        </div>
      </header>

      {notice !== null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {actionError !== null && runTarget === null ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      {loading ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading AI agents">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : agents.length === 0 ? (
        <EmptyState
          title="No agents yet"
          description="An agent is a set of instructions, a few read-only tools and a budget. Create one from the API or the settings screen, then turn it on here."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <ul className="flex flex-col gap-2" aria-label="AI agents">
            {agents.map((agent) => (
              <li key={agent.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(agent.id)}
                  aria-current={agent.id === selectedId}
                  className={`w-full rounded-md border p-3 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    agent.id === selectedId ? "border-primary bg-muted/40" : "border-border"
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium">{agent.name}</span>
                    <Badge tone={AI_AGENT_STATUS_TONES[agent.status] ?? "secondary"}>
                      {agent.status}
                    </Badge>
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {describeAiAgentTrigger(agent)} · last run{" "}
                    {formatAiAgentTimestamp(agent.lastRunAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {selected === null ? (
            <EmptyState title="Pick an agent" description="Select one to see what it may do." />
          ) : (
            <AiAgentDetail
              agent={selected}
              runs={runs}
              working={working}
              onToggle={() => void toggleStatus(selected)}
              onRun={() => {
                setTask("")
                setActionError(null)
                setRunTarget(selected)
              }}
            />
          )}
        </div>
      )}

      <Dialog
        open={runTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRunTarget(null)
        }}
        title={runTarget === null ? "Run this agent" : `Run ${runTarget.name}`}
        description="The run happens in the background, as the agent's owner. It can read what they can read, and anything it wants to change goes to AI approvals first."
      >
        <div className="flex flex-col gap-3">
          <Field
            label="Task for this run"
            htmlFor="ai-agent-task"
            hint="Optional. Leave it empty to run the agent's standing instructions."
          >
            <TextArea
              id="ai-agent-task"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="e.g. Check the people added this week."
            />
          </Field>
          {actionError !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {actionError}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRunTarget(null)} disabled={working}>
              Cancel
            </Button>
            <Button onClick={() => void submitRun()} disabled={working}>
              Queue the run
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}

function AiAgentDetail({
  agent,
  runs,
  working,
  onToggle,
  onRun,
}: {
  agent: AiAgent
  runs: AiAgentRun[]
  working: boolean
  onToggle: () => void
  onRun: () => void
}) {
  const tools = Array.isArray(agent.tools) ? agent.tools : []
  return (
    <section className="flex flex-col gap-4 rounded-md border border-border p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{agent.name}</h2>
          <p className="text-sm text-muted-foreground">
            {describeAiAgentTrigger(agent)}
            {agent.model === null ? "" : ` · ${agent.model}`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onToggle} disabled={working}>
            {agent.status === "enabled" ? "Turn off" : "Turn on"}
          </Button>
          <Button onClick={onRun} disabled={working}>
            Run
          </Button>
        </div>
      </header>

      {agent.status === "disabled" && !canEnableAiAgent(agent) ? (
        <p className="text-sm text-muted-foreground">
          This agent has no owner, so it has nobody to inherit permissions from and cannot be turned
          on.
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <h3 className="text-sm font-medium">Instructions</h3>
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
            {agent.instructions}
          </p>
        </div>
        <div className="flex flex-col gap-3">
          <div>
            <h3 className="text-sm font-medium">Tools</h3>
            <ul className="mt-1 flex flex-wrap gap-1">
              {tools.length === 0 ? (
                <li className="text-sm text-muted-foreground">None — it can only reason.</li>
              ) : (
                tools.map((tool) => (
                  <li key={tool}>
                    <Badge tone={tool === "crm_propose_change" ? "warning" : "secondary"}>
                      {tool}
                    </Badge>
                  </li>
                ))
              )}
            </ul>
          </div>
          <div>
            <h3 className="text-sm font-medium">Budget per run</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {agent.maxSteps} steps · {agent.maxToolCalls} tool calls · {agent.maxTotalTokens}{" "}
              tokens. A run that hits a ceiling stops and says so.
            </p>
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium">Recent runs</h3>
        {runs.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            No runs yet. Press Run to try it — nothing it proposes is applied without approval.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2" aria-label="Recent runs">
            {runs.map((run) => (
              <li key={run.id} className="rounded-md border border-border p-3 text-sm">
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{formatAiAgentTimestamp(run.createdAt)}</span>
                  <Badge tone={AI_AGENT_RUN_STATUS_TONES[run.status] ?? "secondary"}>
                    {AI_AGENT_RUN_STATUS_LABELS[run.status] ?? run.status}
                  </Badge>
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {describeAiAgentRun(run)}
                </span>
                {run.summary === null ? null : <p className="mt-1 text-sm">{run.summary}</p>}
                {run.error === null ? null : (
                  <p className="mt-1 text-sm text-destructive">{run.error}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
