"use client"

import { useCallback, useEffect, useState } from "react"
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Select,
  Skeleton,
  TextField,
} from "@yourcrm/ui"
import { ApiError, apiFetchRaw } from "@/lib/api-client"
import {
  auditChangedKeys,
  auditQueryString,
  DEFAULT_AUDIT_FILTERS,
  describeAuditEvent,
  formatSettingsTimestamp,
  type AuditEvent,
  type AuditFilters,
  type Paginated,
} from "./types"

/**
 * Audit log viewer (spec 40, P0) — READ-ONLY.
 *
 * There is no edit, no delete and no bulk action here, and that is a
 * security property rather than an unfinished feature: `audit_events` is
 * append-only in the database (a trigger rejects UPDATE/DELETE/TRUNCATE),
 * the API exposes GET routes only, and the domain service has no mutating
 * method. A "fix this row" button could not be wired to anything.
 *
 * Pages append rather than replace, because the keyset cursor walks
 * backwards through time and losing the earlier page while investigating
 * an incident is exactly the wrong behaviour.
 */

const SOURCES = ["user", "automation", "ai", "integration", "mcp"]

export function AuditSection() {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [filters, setFilters] = useState<AuditFilters>(DEFAULT_AUDIT_FILTERS)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(
    async (cursor: string | null) => {
      if (cursor === null) setLoading(true)
      else setLoadingMore(true)
      setError(null)
      try {
        const page = await apiFetchRaw<Paginated<AuditEvent>>(
          `/api/v1/settings/audit?${auditQueryString(filters, cursor)}`,
        )
        setEvents((current) => (cursor === null ? page.data : [...current, ...page.data]))
        setNextCursor(page.pagination.nextCursor)
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not load the audit log.")
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [filters],
  )

  useEffect(() => {
    void load(null)
  }, [load])

  const update = (patch: Partial<AuditFilters>) =>
    setFilters((current) => ({ ...current, ...patch }))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Audit log</h2>
        <p className="text-sm text-muted-foreground">
          Append-only record of every important change. Entries can be read and filtered, never
          edited or deleted.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Field label="Object" htmlFor="audit-object">
          <TextField
            id="audit-object"
            value={filters.object}
            placeholder="membership"
            className="w-44"
            onChange={(e) => update({ object: e.currentTarget.value })}
          />
        </Field>
        <Field label="Action" htmlFor="audit-action">
          <TextField
            id="audit-action"
            value={filters.action}
            placeholder="settings.update"
            className="w-48"
            onChange={(e) => update({ action: e.currentTarget.value })}
          />
        </Field>
        <Field label="Source" htmlFor="audit-source">
          <Select
            id="audit-source"
            value={filters.source}
            className="w-40"
            options={[
              { value: "", label: "Any source" },
              ...SOURCES.map((source) => ({ value: source, label: source })),
            ]}
            onChange={(e) => update({ source: e.currentTarget.value })}
          />
        </Field>
        <Field label="From" htmlFor="audit-from">
          <TextField
            id="audit-from"
            type="date"
            value={filters.from}
            className="w-40"
            onChange={(e) => update({ from: e.currentTarget.value })}
          />
        </Field>
        <Field label="To" htmlFor="audit-to">
          <TextField
            id="audit-to"
            type="date"
            value={filters.to}
            className="w-40"
            onChange={(e) => update({ to: e.currentTarget.value })}
          />
        </Field>
        <Button variant="outline" onClick={() => setFilters(DEFAULT_AUDIT_FILTERS)}>
          Clear filters
        </Button>
      </div>

      {loading ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading audit log">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : error !== null ? (
        <ErrorState message={error} onRetry={() => void load(null)} />
      ) : events.length === 0 ? (
        <EmptyState
          title="No audit entries match"
          description="Change a setting or clear the filters to see activity here."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {events.map((event) => {
            const changed = auditChangedKeys(event)
            const isOpen = expanded === event.id
            return (
              <li key={event.id} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">{describeAuditEvent(event)}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatSettingsTimestamp(event.createdAt)}
                      {event.actorId === null ? "" : ` · actor ${event.actorId}`}
                      {event.correlationId === null ? "" : ` · request ${event.correlationId}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone="outline">{event.source}</Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-expanded={isOpen}
                      onClick={() => setExpanded(isOpen ? null : event.id)}
                    >
                      {isOpen ? "Hide detail" : "Show detail"}
                    </Button>
                  </div>
                </div>
                {isOpen ? (
                  <div className="mt-2 flex flex-col gap-2 text-xs">
                    <div className="text-muted-foreground">
                      {changed.length === 0
                        ? "No field-level diff recorded."
                        : `Changed: ${changed.join(", ")}`}
                    </div>
                    <pre className="overflow-x-auto rounded bg-muted/40 p-2">
                      {JSON.stringify({ before: event.before, after: event.after }, null, 2)}
                    </pre>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      {nextCursor !== null ? (
        <div>
          <Button variant="outline" disabled={loadingMore} onClick={() => void load(nextCursor)}>
            {loadingMore ? "Loading…" : "Load older entries"}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
