"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Badge, Button, EmptyState, ErrorState, Select, Skeleton, TextField } from "@yourcrm/ui"
import { ApiError, apiFetchRaw } from "@/lib/api-client"
import {
  flattenGroups,
  groupHits,
  hitOptionId,
  hrefForHit,
  nextActiveIndex,
  objectLabel,
  SEARCH_OBJECT_TYPES,
  type SearchHit,
  type SearchResponse,
} from "./types"

const LIMIT = 20
const LISTBOX_ID = "search-results"

const OBJECT_OPTIONS = [
  { value: "", label: "All records" },
  ...SEARCH_OBJECT_TYPES.map((objectType) => ({
    value: objectType,
    label: objectLabel(objectType),
  })),
]

/**
 * Global search (spec 28-search, P0).
 *
 * Keyboard-first: the input owns focus, ArrowUp/ArrowDown walk the flattened
 * result list across groups, Enter opens the highlighted record and Escape
 * clears the query. The list is a combobox/listbox pair so screen readers
 * announce the active row through `aria-activedescendant`.
 *
 * Results arrive already filtered by the caller's permissions — the API does
 * that server-side (`packages/crm/src/search/policy.ts`). Nothing is hidden
 * here for security reasons; UI hiding is not a boundary.
 */
export default function SearchPage() {
  const router = useRouter()
  const [input, setInput] = useState("")
  const [query, setQuery] = useState("")
  const [object, setObject] = useState("")
  const [hits, setHits] = useState<SearchHit[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Debounce typing into the committed query so every keystroke is not a request.
  useEffect(() => {
    const trimmed = input.trim()
    const timer = setTimeout(() => setQuery(trimmed), 200)
    return () => clearTimeout(timer)
  }, [input])

  const buildPath = useCallback(
    (cursor?: string) => {
      const params = new URLSearchParams({ query, limit: String(LIMIT) })
      if (object !== "") params.set("object", object)
      if (cursor !== undefined) params.set("cursor", cursor)
      return `/api/v1/search?${params.toString()}`
    },
    [query, object],
  )

  const load = useCallback(async () => {
    if (query === "") {
      setHits([])
      setNextCursor(null)
      setHasSearched(false)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetchRaw<SearchResponse>(buildPath())
      setHits(res.data)
      setNextCursor(res.pagination.nextCursor)
      setActiveIndex(res.data.length > 0 ? 0 : -1)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not run that search.")
      setHits([])
      setNextCursor(null)
    } finally {
      setHasSearched(true)
      setLoading(false)
    }
  }, [buildPath, query])

  useEffect(() => {
    void load()
  }, [load])

  const loadMore = async () => {
    if (nextCursor === null) return
    setLoadingMore(true)
    try {
      const res = await apiFetchRaw<SearchResponse>(buildPath(nextCursor))
      setHits((prev) => [...prev, ...res.data])
      setNextCursor(res.pagination.nextCursor)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load more results.")
    } finally {
      setLoadingMore(false)
    }
  }

  const groups = useMemo(() => groupHits(hits), [hits])
  const ordered = useMemo(() => flattenGroups(groups), [groups])
  const active = activeIndex >= 0 ? ordered[activeIndex] : undefined

  const open = (hit: SearchHit | undefined) => {
    if (!hit) return
    const href = hrefForHit(hit)
    if (href !== null) router.push(href)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      setActiveIndex((current) =>
        nextActiveIndex(current, event.key === "ArrowDown" ? 1 : -1, ordered.length),
      )
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      open(active)
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      setInput("")
      setActiveIndex(-1)
    }
  }

  // Keep the highlighted row in view while the keyboard walks the list.
  useEffect(() => {
    if (!active) return
    const element = document.getElementById(hitOptionId(active))
    element?.scrollIntoView({ block: "nearest" })
  }, [active])

  const showSkeleton = loading && hits.length === 0
  const showEmpty = !loading && error === null && hasSearched && hits.length === 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Search</h1>
        <p className="text-sm text-muted-foreground">
          Only records you have permission to see are returned.
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <TextField
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder="Search people, companies, deals…"
          aria-label="Search all records"
          autoFocus
          role="combobox"
          aria-expanded={ordered.length > 0}
          aria-controls={LISTBOX_ID}
          aria-autocomplete="list"
          {...(active === undefined ? {} : { "aria-activedescendant": hitOptionId(active) })}
          className="sm:max-w-xl"
        />
        <Select
          value={object}
          onChange={(e) => setObject(e.currentTarget.value)}
          options={OBJECT_OPTIONS}
          aria-label="Limit results to one record type"
          className="sm:w-56"
        />
      </div>

      <p className="text-xs text-muted-foreground">↑ ↓ to move, Enter to open, Esc to clear.</p>

      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {loading ? "Searching…" : `${hits.length} results`}
      </div>

      {error !== null ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : showSkeleton ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Searching">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : showEmpty ? (
        <EmptyState
          title={`No results for “${query}”`}
          description="Try fewer words, a different spelling, or widen the record type filter."
        />
      ) : !hasSearched ? (
        <EmptyState
          title="Search everything"
          description="Start typing to find people, companies, deals, tasks and more across this workspace."
        />
      ) : (
        <ul
          id={LISTBOX_ID}
          role="listbox"
          aria-label="Search results"
          className="flex flex-col gap-4"
        >
          {groups.map((group) => (
            <li key={group.objectType} role="presentation">
              <div className="mb-1 flex items-center gap-2">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </h2>
                <Badge tone="secondary">{group.hits.length}</Badge>
              </div>
              <ul role="group" aria-label={group.label} className="flex flex-col gap-1">
                {group.hits.map((hit) => {
                  const index = ordered.indexOf(hit)
                  const selected = index === activeIndex
                  const href = hrefForHit(hit)
                  const content = (
                    <>
                      <span className="font-medium">{hit.title}</span>
                      {hit.subtitle !== null && hit.subtitle !== "" ? (
                        <span className="text-xs text-muted-foreground">{hit.subtitle}</span>
                      ) : null}
                      {hit.snippet !== null && hit.snippet !== "" ? (
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          {hit.snippet}
                        </span>
                      ) : null}
                    </>
                  )
                  const className = [
                    "flex flex-col gap-0.5 rounded-md border px-3 py-2 text-sm",
                    selected ? "border-primary bg-accent" : "border-transparent hover:bg-accent/50",
                  ].join(" ")
                  return (
                    <li
                      key={hit.id}
                      id={hitOptionId(hit)}
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => setActiveIndex(index)}
                    >
                      {href === null ? (
                        <div className={className}>{content}</div>
                      ) : (
                        <Link href={href} className={className}>
                          {content}
                        </Link>
                      )}
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {nextCursor !== null && error === null ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </div>
  )
}
