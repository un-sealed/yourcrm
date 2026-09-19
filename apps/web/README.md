# `@yourcrm/web` — Next.js app shell

- App Router: `/`, `/login`, `/signup`, `/onboarding`, `/app/*`.
- `/app/[section]` renders `ModulePlaceholder` until module agents ship
  concrete pages (concrete `page.tsx` wins automatically — no nav rewrites).
- `lib/api-client.ts` — the ONLY fetch path to the API (request ids,
  `{ data }` / `{ error }` envelopes). `lib/store.ts` — Zustand client
  state; server state stays in TanStack Query (`app/providers.tsx`).
- Styling: Tailwind + CSS-var theme (`globals.css`, light/dark via
  next-themes) + primitives from `@yourcrm/ui`.
- Boundaries: `loading.tsx` / `error.tsx` / `not-found.tsx` /
  `global-error.tsx` at root and under `/app`.
- Tests: `bun test` runs unit tests (`lib/`, `app/`, `components/` only —
  `e2e/` belongs to Playwright); `bun run test:e2e` runs the browser smoke
  suite against live web + API servers.
