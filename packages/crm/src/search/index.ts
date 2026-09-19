export { SearchDocumentNotFoundError, createSearchService } from "./service"
export type { SearchRemovalResult, SearchService } from "./service"
export { canReadAllRecords, canReadSearchDocument, readableSearchObjects } from "./policy"
export {
  searchDocumentRefSchema,
  searchDocumentSchema,
  searchHitSchema,
  searchIndexDocumentSchema,
  searchObjectTypeSchema,
  searchQuerySchema,
  searchVisibilitySchema,
} from "./schemas"
export type {
  SearchDocumentDto,
  SearchDocumentRef,
  SearchHitDto,
  SearchIndexDocumentInput,
  SearchQueryInput,
} from "./schemas"
export { SEARCH_OBJECT_TYPES, SEARCH_VISIBILITIES } from "./types"
export type {
  SearchAuditInput,
  SearchDocumentRecord,
  SearchHitListResult,
  SearchHitRecord,
  SearchObjectType,
  SearchServiceContext,
  SearchServiceDeps,
  SearchStore,
  SearchStoreQuery,
  SearchVisibility,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
