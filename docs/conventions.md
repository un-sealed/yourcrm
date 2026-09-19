# Conventions for future agents

## TypeScript

- `strict` everywhere (`tsconfig.base.json`); `skipLibCheck` on.
- Source-only workspace packages (`main: ./src/index.ts`) — no build step
  until a package needs one. Keep it that way unless bundling demands it.
- Prefer `unknown` over `any`; `noUncheckedIndexedAccess` is on — index
  carefully.

## Tests

- `bun test` per workspace (`*.test.ts` next to source). No Vitest config
  needed; keep tests hermetic (no live DB/Redis — stub transports).
- Name tests `domain/behavior`, assert envelopes and denial paths.

## Lint / format

- `eslint.config.mjs` (typescript-eslint recommended, `any` warns).
  `bun run lint` must pass with zero warnings (`--max-warnings=0`).
- Prettier: no semicolons, 100-col, trailing commas. Run `bun run format`
  before committing.

## Commits / PRs

- One module per PR; include migration + tests + docs touch-ups.
- Never commit `.env` or credentials. `.env.example` documents new vars.
- Update the owning package `README.md` when a contract changes.

## Placeholders

Files marked INTENTIONAL PLACEHOLDER reserve an architectural boundary.
Replacing one with a real implementation is expected — rerouting around it
is not. If a boundary is wrong, say so in the PR instead of forking it.
