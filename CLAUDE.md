# YourCRM Coding Context

YourCRM is an AI-native, self-hostable open-source CRM. The repository is
intentionally modular so multiple coding agents can work in parallel.

Read:

1. `README.md` — structure, setup, scripts
2. `AGENTS.md` — agent rules + completion checklist
3. `docs/architecture.md` — layers, dependency rules, conventions
4. Assigned module specification + its dependencies
5. Relevant shared contracts (`packages/*/src`, `DATA-MODEL-CONTRACTS.md`,
   `EVENTS-AND-INTEGRATIONS.md` in the spec pack)

Do not invent conflicting abstractions. Stack is locked: Bun, Turborepo,
TypeScript, Next.js, Hono, Drizzle, PostgreSQL + pgvector, Redis + BullMQ,
S3/MinIO, Zod, TanStack Query, Zustand, Tailwind + shadcn/ui, MCP SDK.
