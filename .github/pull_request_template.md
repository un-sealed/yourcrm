# Pull request

## Module

One module per PR (for example `apps/web` or `packages/crm`):

- Module directory:

## What changed

-
-

## AGENTS.md completion checklist

Check every box that applies to this module; explain any unchecked box below.

- [ ] UI routes implemented (concrete `page.tsx` replaces placeholder)
- [ ] API routes + zod schemas + OpenAPI entries
- [ ] DB migration + repository methods
- [ ] Permissions enforced + tests proving denial
- [ ] Events emitted + audit rows
- [ ] Search/filter/bulk + pagination envelopes
- [ ] Loading/empty/error states, mobile-usable
- [ ] Seed/example data where useful
- [ ] Docs updated (package README if contracts changed)

Exceptions (unchecked items and why):

## Quality gates

- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes with zero warnings
- [ ] `bun run test` passes
- [ ] `bun run build` passes
- [ ] No `bun.lock` or `package.json` changes
- [ ] No added lint suppressions, TypeScript ignores, or skipped tests
