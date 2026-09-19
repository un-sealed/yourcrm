# Wave-2 agent prompt kit

Parallel module agents, one git worktree each, merged centrally.

```bash
bun run docs/agent-prompts/render.ts --list         # the ownership matrix
bun run docs/agent-prompts/render.ts --worktrees    # worktree setup commands
bun run docs/agent-prompts/render.ts companies      # one paste-ready prompt
bun run docs/agent-prompts/render.ts --all --out /tmp/prompts
```

`modules.ts` is the single source of truth for every identifier that must not
collide across concurrent agents. Change it there, re-render.

---

## Prerequisites — Wave 2 cannot start until all of these are true

The template hands each agent a reference implementation to mirror and a set
of shared seams to stay out of. Both must exist first, or eleven agents will
each invent their own.

- [ ] Repo is under git (`git init` — it currently is not)
- [ ] **People implemented end to end** at the paths listed in template §2.
      This is the reference every other agent copies. Build it with your
      strongest model; it sets the pattern for all eleven.
- [ ] **`packages/ui` has the shared primitives**: DataTable (columns, sort,
      inline edit), FilterBuilder, SavedViews, BulkBar, RecordHeader,
      Timeline, form fields, Skeleton / EmptyState / ErrorState. Today it
      exports only `Button`.
- [ ] **Audit helper exists** — e.g. `writeAudit()` in `@yourcrm/database`.
      `AGENTS.md` mandates an audit row per mutation; there is no helper yet.
- [ ] **API module registry** at `apps/api/src/routes/modules/`, auto-mounted
      by `v1.ts`, so agents never edit `v1.ts`.
- [ ] **Barrel strategy** for `packages/crm/src/index.ts` and
      `packages/database/src/schema/index.ts` — either auto-generated, or
      accepted as a central merge step you do by hand.
- [ ] **`@yourcrm/events` exports every Wave-2 event constant.** Run
      `--list` and cross-check `modules.ts` against `packages/events`:
      `pipeline.*`, `product.*`, `form.*`, `file.*`, `import.*`, `export.*`
      and `*.deleted` are **not** declared today. Agents are forbidden from
      adding them, so this must land first.
- [ ] Auth actually works — a real session, not the 401 stub. Nobody can
      build or test a signed-in page until then.

---

## Running the fan-out

```bash
bun run docs/agent-prompts/render.ts --worktrees | sh
```

One worktree per module under `../yourcrm-<slug>`, each on `agent/<slug>`.
Point one opencode session at each directory and paste that module's rendered
prompt as the opening message.

**Give each agent its prompt and nothing else.** Do not paste the whole spec
pack — the prompt already points at the one spec file it should read. Weak
models degrade fast with unfocused context.

### Why mirroring matters more than instruction

Free/cheap models are much stronger at transcribing an existing pattern than
at designing a new one. The template is built around that: §2 tells the agent
to copy People's structure, and §3 forbids the open-ended parts of the spec
(merge, import, AI, automation). The narrower the creative surface, the higher
the hit rate. Resist widening it.

---

## Merge order

Dependency-light first, so conflicts surface early and cheap:

```text
pipelines → companies → products → tasks → activities
         → deals → leads → files → forms → search → import-export
```

After each merge, from the integration branch:

```bash
bun run db:migrate && bun run typecheck && bun run lint && bun run test
```

Central merge steps you own (agents are forbidden from touching these):

1. Add the module's export line to `packages/crm/src/index.ts`
2. Add the schema export to `packages/database/src/schema/index.ts`
3. Confirm the route registry picked up `routes/modules/<slug>.ts`
4. Re-run the gates before merging the next branch

---

## Reviewing an agent's output

Check these before trusting a `COMPLETE` report — they are the failure modes
weak models produce most often:

- `git diff --stat main...agent/<slug>` touches **only** the template §4 paths
- No `package.json` or `bun.lock` in the diff
- No FK constraint to a table the agent does not own (breaks migration order)
- `requirePermission()` is the **first** statement in every service method
- At least one test asserts a permission **denial**, not just the happy path
- No `any`, no `eslint-disable`, no `.skip()` added to make gates pass
- Event constants imported from `@yourcrm/events`, not string literals
- UI imports primitives from `@yourcrm/ui` instead of redefining a table

A `BLOCKED` report naming a missing seam is a better outcome than a
`COMPLETE` report that worked around one. Fix the seam centrally, then re-run
that agent.

---

## Wave 3 (deferred)

Calendar, Email, Unified Inbox, WhatsApp, Calling, Quotes, Invoices,
Automation, Reports, Dashboards, Integrations, Custom Objects. These are not
mirror-shaped — they need external integrations, cross-module writes, or
engine work — so the template does not fit them as-is. See
`WAVE_3_DEFERRED` in `modules.ts`.

---

## Hands-off launcher — `launch.sh`

```bash
./docs/agent-prompts/launch.sh preflight   # ~35s, finds models that actually work
./docs/agent-prompts/launch.sh up          # git init + 11 worktrees + bun install
./docs/agent-prompts/launch.sh run -j 3    # render prompts, run all agents headless
./docs/agent-prompts/launch.sh status      # one line per agent
```

`run` needs no further input: it renders each module's prompt, `cd`s into that
module's worktree, and invokes `opencode run --auto` with the prompt as the
message. Logs land in `.agent-runs/<slug>.log` (gitignored).

Useful flags: `-j N` parallelism, `-o companies,deals` subset, `-m model1,model2`
to bypass the preflight pool.

Prefer to watch them? `./launch.sh tmux` opens one TUI window per module with
the prompt pre-typed and submitted.

### Preflight is not optional

**`opencode run` exits 0 even when the model is locked, out of quota, or
unsupported.** Observed failure modes on this machine, all exit 0:

```text
Error: Insufficient balance...                     opencode/muse-spark-1.3
Error: The Token Plan usage limit has been reached minimax/MiniMax-M3
Error: model_requires_purchase...                  explabs/claude-fable-5.1
Error: Free models are not available to this...    orcarouter/*-free
Error: Model '...' is not supported                kira/*, opencode-zen/omen-alpha-free
```

So the launcher classifies runs by grepping the transcript for `^Error:` and
for the `## Status` section the prompt template requires — never by exit code.
A run with no `## Status` is reported `UNCLEAR`, not success.

Probes run in parallel with a 45s cap. Serially they took over 15 minutes,
because locked providers retry several times before erroring.

### Current usable pool (preflighted)

```text
opencode/muse-spark-1.3-contributor-free   <- free, first in rotation
opencode/muse-spark-1.2-contributor-free   <- free
explabs/deepseek-v4-flash                  <- $0.06/$0.12 per Mtok
explabs/qwen3.8-27b                        <- $0.32/$2.40 per Mtok
```

Models are assigned round-robin in pool order, so with `-j 3` the free
muse-spark models carry most of the load. Re-run `preflight` whenever quota
resets or you add a provider.

Two things to be aware of:

- The `contributor-free` tier collects prompts and completions to improve the
  model. Your CRM source goes to the provider as training data. The non-free
  `opencode/muse-spark-1.3` does not, but needs credit.
- `--auto` auto-approves every permission, so agents run shell commands in
  their worktree unreviewed. That is the point of a hands-off run, but it is
  why each agent is isolated in its own worktree and branch.
