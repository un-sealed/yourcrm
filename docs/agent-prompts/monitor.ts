#!/usr/bin/env bun
/**
 * Live view of the YourCRM agent fleet, read from the opencode server API.
 *
 *   bun run docs/agent-prompts/monitor.ts            one snapshot
 *   bun run docs/agent-prompts/monitor.ts --watch    refresh every 5s
 *   bun run docs/agent-prompts/monitor.ts --json     machine readable
 *   bun run docs/agent-prompts/monitor.ts --stop <slug>   interrupt one agent
 *
 * Reads the server URL from `opencode service status` and credentials from
 * `opencode pair`, so it follows the running instance without configuration.
 */

const WORKTREE_RE = /yourcrm-([a-z0-9-]+)$/

type Session = {
  id: string
  title?: string
  agent?: string
  outcome?: string
  cost?: number
  model?: { id: string; providerID: string }
  tokens?: { input: number; output: number; reasoning: number }
  time?: { created: number; updated: number; idle?: number }
  location?: { directory?: string }
}

async function sh(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  return (await new Response(p.stdout).text()).trim()
}

async function connect() {
  const url = (await sh(["opencode", "service", "status"])).split(/\s+/).find((s) => s.startsWith("http"))
  if (!url) throw new Error("opencode server not running — `opencode service start`")
  const pair = await sh(["opencode", "pair"])
  const user = pair.match(/Username\s+(\S+)/)?.[1]
  const pass = pair.match(/Password\s+(\S+)/)?.[1]
  if (!user || !pass) throw new Error("could not read credentials from `opencode pair`")
  const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64")
  return {
    async get<T>(path: string): Promise<T> {
      const r = await fetch(`${url}${path}`, { headers: { Authorization: auth } })
      if (!r.ok) throw new Error(`${path} -> ${r.status}`)
      return (await r.json()).data as T
    },
    async post(path: string) {
      return fetch(`${url}${path}`, { method: "POST", headers: { Authorization: auth } })
    },
  }
}

/** Newest session per worktree — an agent re-run supersedes its predecessor. */
function fleet(sessions: Session[]) {
  const byModule = new Map<string, Session>()
  for (const s of sessions) {
    const slug = s.location?.directory?.match(WORKTREE_RE)?.[1]
    if (!slug) continue
    const prev = byModule.get(slug)
    if (!prev || (s.time?.created ?? 0) > (prev.time?.created ?? 0)) byModule.set(slug, s)
  }
  return [...byModule.entries()].sort(([a], [b]) => a.localeCompare(b))
}

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
}

/**
 * opencode marks a session idle when the turn ends. Running = no idle stamp
 * yet. `outcome` is only trustworthy once idle is set.
 */
function classify(s: Session): { label: string; running: boolean } {
  const idle = s.time?.idle
  if (!idle) return { label: C.cyan("RUNNING"), running: true }
  if (s.outcome === "failed") return { label: C.red("FAILED"), running: false }
  if (s.outcome === "succeeded") return { label: C.green("done"), running: false }
  return { label: C.yellow(s.outcome ?? "unknown"), running: false }
}

const fmtAge = (ms: number) => {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}
const fmtTok = (n?: number) => (!n ? "0" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`)

async function snapshot(api: Awaited<ReturnType<typeof connect>>, json: boolean) {
  const sessions = await api.get<Session[]>("/api/session")
  const rows = fleet(sessions)

  if (json) {
    console.log(JSON.stringify(rows.map(([slug, s]) => ({ slug, ...classify(s), id: s.id, cost: s.cost, tokens: s.tokens })), null, 2))
    return
  }

  const now = Date.now()
  console.log(C.bold(`\nYourCRM agent fleet — ${new Date().toLocaleTimeString()}\n`))
  if (!rows.length) {
    console.log(C.dim("  no agent worktrees found. run: ./launch.sh up && ./launch.sh run\n"))
    return
  }
  console.log(C.dim("  MODULE           STATUS    ELAPSED   IN/OUT      COST     MODEL"))
  let running = 0
  let cost = 0
  for (const [slug, s] of rows) {
    const c = classify(s)
    if (c.running) running++
    cost += s.cost ?? 0
    const elapsed = fmtAge((s.time?.idle ?? now) - (s.time?.created ?? now))
    const tok = `${fmtTok(s.tokens?.input)}/${fmtTok(s.tokens?.output)}`
    console.log(
      `  ${slug.padEnd(16)} ${c.label.padEnd(17)} ${elapsed.padEnd(9)} ${tok.padEnd(11)} ` +
        `$${(s.cost ?? 0).toFixed(3).padEnd(7)} ${C.dim(s.model?.id ?? "?")}`,
    )
  }
  console.log(
    C.dim(`\n  ${rows.length} agents · ${running} running · $${cost.toFixed(3)} total\n`),
  )

  // A pending permission request means an agent is silently stuck waiting.
  try {
    const perms = await api.get<unknown[]>("/api/permission/request")
    if (perms?.length) console.log(C.yellow(`  ⚠ ${perms.length} pending permission request(s) — agents are blocked\n`))
  } catch {}
}

const args = Bun.argv.slice(2)
const api = await connect()

if (args.includes("--stop")) {
  const slug = args[args.indexOf("--stop") + 1]
  const sessions = await api.get<Session[]>("/api/session")
  const hit = fleet(sessions).find(([s]) => s === slug)
  if (!hit) throw new Error(`no session for '${slug}'`)
  await api.post(`/api/session/${hit[1].id}/interrupt`)
  console.log(`interrupted ${slug} (${hit[1].id})`)
} else if (args.includes("--watch")) {
  for (;;) {
    process.stdout.write("\x1b[2J\x1b[H")
    await snapshot(api, false)
    await Bun.sleep(5000)
  }
} else {
  await snapshot(api, args.includes("--json"))
}
