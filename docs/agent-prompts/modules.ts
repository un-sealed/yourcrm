/**
 * Wave-2 module registry — one entry per parallel agent.
 *
 * Single source of truth for the identifiers that must never collide across
 * concurrently running agents: migration slot, route prefix, table names,
 * event names. Edit here, then re-render prompts with `render.ts`.
 *
 * Migration slots are spaced by 10 so a module can add a follow-up migration
 * (0021, 0022 …) without reaching into a neighbour's range.
 */

export type ModuleSpec = {
  slug: string
  title: string
  specFile: string
  migrationSlot: string
  permissionObject: string
  tables: string[]
  events: string[]
  /** Extra P0 bullets appended to the generic scope section. */
  p0Extra: string[]
  /** Modules whose records this one references by plain uuid (no FK). */
  softRefs: string[]
}

export const WAVE_2: ModuleSpec[] = [
  {
    slug: "companies",
    title: "Companies",
    specFile: "07-companies.md",
    migrationSlot: "0020",
    permissionObject: "company",
    tables: ["companies", "company_addresses"],
    events: ["company.created", "company.updated", "company.deleted"],
    p0Extra: [
      "- Company hierarchy: optional `parent_company_id` (self-reference is fine, it is your table)",
      "- People-at-company list on the detail page, read via the People API",
    ],
    softRefs: ["people"],
  },
  {
    slug: "leads",
    title: "Leads",
    specFile: "08-leads.md",
    migrationSlot: "0030",
    permissionObject: "lead",
    tables: ["leads"],
    events: ["lead.created", "lead.updated", "lead.qualified", "lead.converted"],
    p0Extra: [
      "- Lead status lifecycle (new → working → qualified → unqualified)",
      "- Lead scoring field stored and displayed, but computed manually for now",
      "- `lead.converted` emits with target ids; the actual conversion wiring to",
      "  Person/Company/Deal is a later integration pass — store the ids only",
    ],
    softRefs: ["people", "companies", "deals"],
  },
  {
    slug: "deals",
    title: "Deals",
    specFile: "09-deals.md",
    migrationSlot: "0040",
    permissionObject: "deal",
    tables: ["deals"],
    events: ["deal.created", "deal.updated", "deal.stage_changed", "deal.won", "deal.lost"],
    p0Extra: [
      "- Kanban board view grouped by stage, in addition to the table view",
      "- Stage change is its own service method and emits `deal.stage_changed`",
      "- `pipeline_id` / `stage_id` are plain uuid columns — the Pipelines agent",
      "  owns those tables and they may not exist when your migration runs",
      "- Amount + currency, close date, weighted value",
    ],
    softRefs: ["pipelines", "people", "companies"],
  },
  {
    slug: "pipelines",
    title: "Pipelines",
    specFile: "10-pipelines.md",
    migrationSlot: "0050",
    permissionObject: "pipeline",
    tables: ["pipelines", "pipeline_stages"],
    events: ["pipeline.created", "pipeline.updated", "pipeline.stage_reordered"],
    p0Extra: [
      "- Pipeline + ordered stages CRUD with drag-to-reorder persistence",
      "- Stage probability and `is_won` / `is_lost` terminal flags",
      "- Seed one default sales pipeline so the Deals module has something to point at",
    ],
    softRefs: [],
  },
  {
    slug: "activities",
    title: "Activities",
    specFile: "11-activities.md",
    migrationSlot: "0060",
    permissionObject: "activity",
    tables: ["activities"],
    events: ["activity.created", "activity.updated", "activity.completed"],
    p0Extra: [
      "- Polymorphic association: `subject_type` + `subject_id` plain columns",
      "- Types: note, call, meeting, email (email body is out of scope)",
      "- Export a reusable timeline query so other modules can render a feed",
    ],
    softRefs: ["people", "companies", "deals", "leads"],
  },
  {
    slug: "tasks",
    title: "Tasks",
    specFile: "12-tasks.md",
    migrationSlot: "0070",
    permissionObject: "task",
    tables: ["tasks"],
    events: ["task.created", "task.updated", "task.completed"],
    p0Extra: [
      "- Due date, priority, assignee, completion toggle",
      "- 'My tasks' default filter scoped to the current actor",
      "- Overdue highlighting in the list view",
    ],
    softRefs: ["people", "companies", "deals"],
  },
  {
    slug: "products",
    title: "Products",
    specFile: "18-products.md",
    migrationSlot: "0080",
    permissionObject: "product",
    tables: ["products", "product_prices"],
    events: ["product.created", "product.updated", "product.archived"],
    p0Extra: [
      "- SKU, name, description, active flag",
      "- Multi-currency price list rows",
    ],
    softRefs: [],
  },
  {
    slug: "forms",
    title: "Forms",
    specFile: "23-forms.md",
    migrationSlot: "0090",
    permissionObject: "form",
    tables: ["forms", "form_fields", "form_submissions"],
    events: ["form.created", "form.updated", "form.submitted"],
    p0Extra: [
      "- Form builder: ordered field definitions with type + required flag",
      "- Public submission endpoint (unauthenticated) that is rate-limit aware",
      "- Submissions list; lead creation from a submission is a later pass",
    ],
    softRefs: ["leads"],
  },
  {
    slug: "files",
    title: "Files",
    specFile: "29-files.md",
    migrationSlot: "0100",
    permissionObject: "file",
    tables: ["files"],
    events: ["file.uploaded", "file.deleted"],
    p0Extra: [
      "- Bytes go to S3/MinIO via `@yourcrm/storage`; metadata rows in Postgres",
      "- Presigned upload + download URLs, never proxy bytes through the API",
      "- Polymorphic attachment: `subject_type` + `subject_id` plain columns",
      "- Reject uploads above the configured size limit with a clear envelope error",
    ],
    softRefs: ["people", "companies", "deals"],
  },
  {
    slug: "search",
    title: "Search",
    specFile: "28-search.md",
    migrationSlot: "0110",
    permissionObject: "search",
    tables: ["search_index"],
    events: [],
    p0Extra: [
      "- Implement behind the existing `SearchProvider` interface in `@yourcrm/search`",
      "- Postgres full-text search only; no Elasticsearch, no pgvector yet",
      "- A single denormalized index table written by an indexing service",
      "- Global search UI with grouped results and keyboard navigation",
      "- Results must be filtered by the caller's permissions, not just workspace",
      "- You may add files under `packages/search/src/` — that package is yours",
    ],
    softRefs: [],
  },
  {
    slug: "import-export",
    title: "Import / Export",
    specFile: "30-import-export.md",
    migrationSlot: "0120",
    permissionObject: "import_export",
    tables: ["import_jobs", "export_jobs"],
    events: ["import.started", "import.completed", "export.completed"],
    p0Extra: [
      "- CSV only for P0. Excel and JSON are deferred.",
      "- Column mapping UI, dry-run validation preview, then background execution",
      "- Runs as a BullMQ job — register it under `apps/worker/src/jobs/`, which",
      "  is the one place outside your tree you may add new files",
      "- Exports must obey the caller's permissions and record an audit row",
      "- Generic over object type; do not special-case a single module",
    ],
    softRefs: [],
  },
]

export const WAVE_3_DEFERRED = [
  "13-calendar.md",
  "14-email.md",
  "15-unified-inbox.md",
  "16-whatsapp.md",
  "17-calling.md",
  "19-quotes.md",
  "20-invoices-payments.md",
  "25-automation.md",
  "26-reports.md",
  "27-dashboards.md",
  "31-integrations.md",
  "33-custom-objects-fields.md",
]
