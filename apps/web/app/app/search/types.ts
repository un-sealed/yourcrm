/**
 * Global search page contracts and pure helpers (spec 28-search, P0).
 *
 * Everything here is framework-free so the grouping and keyboard-navigation
 * rules are unit-tested without a DOM (`grouping.test.ts`).
 */

/** One ranked hit as returned by `GET /api/v1/search` (envelope `data` item). */
export type SearchHit = {
  id: string
  workspaceId: string
  objectType: string
  recordId: string
  title: string
  subtitle: string | null
  snippet: string | null
  rank: number
  ownerId: string | null
  visibility: string
  recordUpdatedAt: string
}

export type SearchResponse = {
  data: SearchHit[]
  pagination: { nextCursor: string | null; limit: number }
}

/** Object types the index accepts, in the order groups are rendered. */
export const SEARCH_OBJECT_TYPES = [
  "person",
  "company",
  "lead",
  "deal",
  "activity",
  "task",
  "file",
  "form",
  "product",
  "invoice",
] as const

export type SearchObjectType = (typeof SEARCH_OBJECT_TYPES)[number]

export const OBJECT_LABELS: Record<string, string> = {
  person: "People",
  company: "Companies",
  lead: "Leads",
  deal: "Deals",
  activity: "Activities",
  task: "Tasks",
  file: "Files",
  form: "Forms",
  product: "Products",
  invoice: "Invoices",
}

/** List route each object type lives under. Detail pages append the record id. */
const OBJECT_ROUTES: Record<string, string> = {
  person: "/app/people",
  company: "/app/companies",
  lead: "/app/leads",
  deal: "/app/deals",
  activity: "/app/activities",
  task: "/app/tasks",
  file: "/app/files",
  form: "/app/forms",
  product: "/app/products",
  invoice: "/app/invoices",
}

export function objectLabel(objectType: string): string {
  return OBJECT_LABELS[objectType] ?? objectType
}

/**
 * Record link for a hit, or null for object types the web app does not route
 * yet — the row still renders, it just is not clickable.
 */
export function hrefForHit(hit: Pick<SearchHit, "objectType" | "recordId">): string | null {
  const base = OBJECT_ROUTES[hit.objectType]
  return base === undefined ? null : `${base}/${hit.recordId}`
}

export type SearchGroup = {
  objectType: string
  label: string
  hits: SearchHit[]
}

/**
 * Group hits by object type, preserving rank order inside each group and
 * ordering the groups by {@link SEARCH_OBJECT_TYPES}. Unknown object types
 * sort last so a newly indexed module still shows up.
 */
export function groupHits(hits: SearchHit[]): SearchGroup[] {
  const byType = new Map<string, SearchHit[]>()
  for (const hit of hits) {
    const bucket = byType.get(hit.objectType)
    if (bucket) bucket.push(hit)
    else byType.set(hit.objectType, [hit])
  }
  const order = (objectType: string) => {
    const at = (SEARCH_OBJECT_TYPES as readonly string[]).indexOf(objectType)
    return at < 0 ? SEARCH_OBJECT_TYPES.length : at
  }
  return [...byType.entries()]
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([objectType, groupHitList]) => ({
      objectType,
      label: objectLabel(objectType),
      hits: groupHitList,
    }))
}

/** Groups flattened back into the order the keyboard walks them. */
export function flattenGroups(groups: SearchGroup[]): SearchHit[] {
  return groups.flatMap((group) => group.hits)
}

/**
 * Move the keyboard cursor. Wraps at both ends so ArrowUp from the first row
 * lands on the last, and returns -1 when there is nothing to select.
 */
export function nextActiveIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return -1
  if (current < 0) return delta > 0 ? 0 : count - 1
  return (current + delta + count) % count
}

/** DOM id for a result row, so the input can own `aria-activedescendant`. */
export function hitOptionId(hit: Pick<SearchHit, "objectType" | "recordId">): string {
  return `search-hit-${hit.objectType}-${hit.recordId}`
}
