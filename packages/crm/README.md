# `@yourcrm/crm`

Domain-service boundary for all CRM modules (people, companies, leads,
deals, pipelines, activities, tasks, …). Placeholder in Phase 0 — it
establishes the import direction so API/MCP/AI agents consume services,
never repositories directly.

## Module services (people is the golden reference)

Each module lives in `src/<module>/` with its own barrel and is imported
via subpath until the integrator extends `scripts/gen-barrels.ts` past
top-level files:

```ts
import { createPeopleService } from "@yourcrm/crm/src/people"
```

The service takes structural ports — no database dependency in this
package. The API layer adapts the drizzle repository and `writeAudit`:

```ts
createPeopleService({ store, audit, events })
```

Every method calls `requirePermission()` first, works through `store`,
emits via the `CrmEvents` constant, and audits mutations with
before/after. See `src/people/service.ts` and mirror it exactly.
