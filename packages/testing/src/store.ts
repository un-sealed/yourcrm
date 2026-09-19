import type { BaseRecord } from "@yourcrm/validation"

/**
 * Hermetic, database-shaped seam for tests: a workspace-scoped,
 * soft-delete-aware in-memory store behind a repository-style interface.
 * No Postgres, no Redis — `docs/conventions.md` requires hermetic tests.
 *
 * ```ts
 * const people = createStore<Person>()
 * people.insert({ ...makeBaseRecord({ workspaceId }), firstName: "Ada" })
 * ```
 */
export type InMemoryStore<T extends BaseRecord> = {
  /** Insert a record (stored by copy). Overwrites the same id. */
  insert: (record: T) => T
  /** Get a live (non-deleted) record in this workspace, or null. */
  get: (id: string, workspaceId: string) => T | null
  /** List live records in this workspace, in insertion order. */
  list: (workspaceId: string) => T[]
  /** Patch a live record (bumps `updatedAt`); null when missing/deleted. */
  update: (id: string, workspaceId: string, patch: Partial<T>) => T | null
  /** Soft-delete (sets `deletedAt`); false when missing or already deleted. */
  remove: (id: string, workspaceId: string) => boolean
  /** Clear `deletedAt`; false when missing or not deleted. */
  restore: (id: string, workspaceId: string) => boolean
  /** Forget everything (typically in `beforeEach`). */
  clear: () => void
}

export function createStore<T extends BaseRecord>(): InMemoryStore<T> {
  const rows = new Map<string, T>()

  const key = (id: string, workspaceId: string): string => `${workspaceId}:${id}`
  const live = (row: T | undefined, workspaceId: string): T | null => {
    if (!row || row.workspaceId !== workspaceId || row.deletedAt) return null
    return { ...row }
  }

  return {
    insert: (record) => {
      const copy = { ...record }
      rows.set(key(copy.id, copy.workspaceId), copy)
      return { ...copy }
    },
    get: (id, workspaceId) => live(rows.get(key(id, workspaceId)), workspaceId),
    list: (workspaceId) => {
      const out: T[] = []
      for (const row of rows.values()) {
        if (row.workspaceId === workspaceId && !row.deletedAt) out.push({ ...row })
      }
      return out
    },
    update: (id, workspaceId, patch) => {
      const current = live(rows.get(key(id, workspaceId)), workspaceId)
      if (!current) return null
      // Identity and creation-audit fields are store-managed, never patched.
      const guarded = {
        ...patch,
        id,
        workspaceId,
        createdAt: current.createdAt,
        createdBy: current.createdBy,
      }
      const next = { ...current, ...guarded, updatedAt: new Date(Date.now()).toISOString() }
      rows.set(key(id, workspaceId), next)
      return { ...next }
    },
    remove: (id, workspaceId) => {
      const current = live(rows.get(key(id, workspaceId)), workspaceId)
      if (!current) return false
      rows.set(key(id, workspaceId), {
        ...current,
        deletedAt: new Date(Date.now()).toISOString(),
      })
      return true
    },
    restore: (id, workspaceId) => {
      const row = rows.get(key(id, workspaceId))
      if (!row || row.workspaceId !== workspaceId || !row.deletedAt) return false
      rows.set(key(id, workspaceId), { ...row, deletedAt: null })
      return true
    },
    clear: () => {
      rows.clear()
    },
  }
}
