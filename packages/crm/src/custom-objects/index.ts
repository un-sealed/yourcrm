export { createCustomObjectsService } from "./service"
export type { CustomObjectsService } from "./service"
export {
  CustomObjectConflictError,
  CustomObjectFieldNotFoundError,
  CustomObjectNotFoundError,
  CustomObjectRecordNotFoundError,
  CustomObjectValidationError,
} from "./errors"
export {
  CUSTOM_OBJECT_FIELD_TYPES,
  applyCustomObjectFieldDefaults,
  buildCustomObjectRecordSchema,
  customObjectOptionValues,
  deriveCustomObjectDisplayName,
  isCustomObjectFieldType,
  mergeCustomObjectRecordValues,
  parseCustomObjectRecordValues,
} from "./field-schema"
export type {
  BuildCustomObjectRecordSchemaOptions,
  CustomObjectFieldDefinitionLike,
  CustomObjectFieldOption,
  CustomObjectFieldType,
} from "./field-schema"
export {
  CUSTOM_OBJECT_BUILT_IN_TYPES,
  CUSTOM_OBJECT_FIELD_KEY_RE,
  CUSTOM_OBJECT_RESERVED_FIELD_KEYS,
  CUSTOM_OBJECT_RESERVED_SLUGS,
  CUSTOM_OBJECT_SLUG_RE,
  isValidCustomObjectSlug,
  parseCustomObjectFieldKey,
  parseCustomObjectSlug,
} from "./naming"
export {
  createCustomObjectFieldSchema,
  createCustomObjectRecordSchema,
  createCustomObjectSchema,
  customObjectFieldDefaultSchema,
  customObjectFieldOptionSchema,
  customObjectFieldSchema,
  customObjectFieldTypeSchema,
  customObjectQuerySchema,
  customObjectRecordQuerySchema,
  customObjectRecordSchema,
  customObjectSchema,
  customObjectSlugInputSchema,
  updateCustomObjectFieldSchema,
  updateCustomObjectRecordSchema,
  updateCustomObjectSchema,
} from "./schemas"
export type {
  CreateCustomObjectFieldInput,
  CreateCustomObjectInput,
  CreateCustomObjectRecordInput,
  CustomObjectDto,
  CustomObjectFieldDto,
  CustomObjectQuery,
  CustomObjectRecordDto,
  CustomObjectRecordQuery,
  UpdateCustomObjectFieldInput,
  UpdateCustomObjectInput,
  UpdateCustomObjectRecordInput,
} from "./schemas"
export type {
  CustomObjectAuditInput,
  CustomObjectDefinitionRecord,
  CustomObjectFieldRecord,
  CustomObjectListQuery,
  CustomObjectListResult,
  CustomObjectRecordListQuery,
  CustomObjectRecordListResult,
  CustomObjectRecordRow,
  CustomObjectsServiceContext,
  CustomObjectsServiceDeps,
  CustomObjectsStore,
  CustomObjectWithFields,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
