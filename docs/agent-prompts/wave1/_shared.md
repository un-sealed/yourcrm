## Ground rules (identical for every Wave-1 agent)

You are one of four agents working on this repository **at the same time**,
each in its own git worktree on its own branch. Your work is merged alongside
theirs. Staying inside your assigned files is not a style preference — a
stray edit breaks three other agents' merges.

### Read first
1. `AGENTS.md`
2. `docs/architecture.md`
3. `docs/conventions.md`
4. Your spec, named in your task below

### Absolute rules
- **Never run `bun add`, `npm install`, or edit any `package.json`.** Every
  dependency is already installed. If one is genuinely missing: stop, report.
- **Never run `git push`, `git merge`, `git rebase`, or touch another branch.**
  Commit to your own branch only.
- **Never edit files outside your ownership list.** If you need to, stop and
  report it as a blocker. A precise blocker report is a success; a silent
  workaround is a failure that costs three other agents their merge.
- **Never delete or modify anything outside your worktree directory.**
- No business logic in Hono route handlers. No SQL outside `packages/database`.
- `packages/crm` and `packages/ui` must not import each other.
- Prettier: no semicolons, 100 columns, trailing commas.
- `noUncheckedIndexedAccess` is on — index arrays carefully.

### Definition of done
```bash
bun run typecheck && bun run lint && bun run test && bun run build
```
All four must pass; lint with **zero** warnings. Never reach the bar by adding
`any`, `eslint-disable`, `@ts-ignore`, or `.skip()`. If you cannot make it
pass honestly, report it.

### Required final report
```markdown
## Agent
<your name> — branch <your branch>

## Status
COMPLETE | BLOCKED | PARTIAL

## Files created
## Files modified
## Public API added
<exported symbols other agents will import>

## Quality gates
typecheck: PASS/FAIL
lint:      PASS/FAIL
test:      PASS/FAIL (N passed)
build:     PASS/FAIL

## Blockers
## Notes for downstream agents
```
