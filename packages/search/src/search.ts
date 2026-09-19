import { z } from "zod"

/**
 * Search abstraction (spec 01-architecture). Phase 0 uses PostgreSQL
 * full-text (`to_tsvector`) + trigram indexes behind this interface.
 * Meilisearch/Typesense can replace the implementation later without
 * touching domain callers.
 */

export const searchQuerySchema = z.object({
  workspaceId: z.string().min(1),
  query: z.string().min(1).max(500),
  objects: z.array(z.string()).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export type SearchQuery = z.infer<typeof searchQuerySchema>

export type SearchHit = {
  object: string
  recordId: string
  title: string
  snippet?: string
  rank: number
}

export type SearchResult = {
  hits: SearchHit[]
  query: string
}

export interface SearchProvider {
  readonly name: string
  search(query: SearchQuery): Promise<SearchResult>
  /** Called by domain services after writes; no-op for synchronous FTS. */
  indexDocument?(doc: {
    object: string
    recordId: string
    workspaceId: string
    text: string
  }): Promise<void>
}

/** Placeholder provider: proves the interface. Domain FTS lands in Phase 1. */
export class NoopSearchProvider implements SearchProvider {
  readonly name = "noop"
  async search(query: SearchQuery): Promise<SearchResult> {
    return { hits: [], query: query.query }
  }
}

let provider: SearchProvider = new NoopSearchProvider()

export function getSearchProvider(): SearchProvider {
  return provider
}

export function setSearchProvider(next: SearchProvider): void {
  provider = next
}
