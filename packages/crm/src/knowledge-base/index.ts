export {
  KbArticleNotFoundError,
  KbCategoryNotFoundError,
  KbConflictError,
  KbValidationError,
} from "./errors"
export { createKnowledgeBaseService } from "./service"
export type { KnowledgeBaseService } from "./service"
export {
  createKbArticleSchema,
  createKbCategorySchema,
  kbArticleQuerySchema,
  kbArticleSchema,
  kbArticleStatusSchema,
  kbCategorySchema,
  kbSlugInputSchema,
  updateKbArticleSchema,
  updateKbCategorySchema,
} from "./schemas"
export type {
  CreateKbArticleInput,
  CreateKbCategoryInput,
  KbArticleDto,
  KbArticleQuery,
  KbCategoryDto,
  UpdateKbArticleInput,
  UpdateKbCategoryInput,
} from "./schemas"
export { isValidKbSlug, KB_SLUG_RE, parseKbSlug } from "./slug"
export { isKbArticleStatus, KB_ARTICLE_STATUSES } from "./types"
export type {
  KbArticleListQuery,
  KbArticleListResult,
  KbArticleRecord,
  KbArticleStatus,
  KbArticleStore,
  KbAuditInput,
  KbCategoryRecord,
  KbCategoryStore,
  KbSearchArticlePayload,
  KbSearchIndexPort,
  KnowledgeBaseServiceContext,
  KnowledgeBaseServiceDeps,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
