# `@yourcrm/validation`

Boundary validation shared by API routes, workers, and MCP tools.

- `src/envelopes.ts` — pagination query, paginated envelope factory,
  error envelope, `BaseRecord` contract (see `DATA-MODEL-CONTRACTS.md`).
- Domain packages extend these; they must not invent parallel envelopes.
