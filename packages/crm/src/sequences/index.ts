/**
 * Sales engagement / sequences module (spec 47-sales-engagement, P0).
 *
 * Every export is prefixed `SalesSequence`/`salesSequence`/
 * `SALES_SEQUENCE` on purpose: `../index.ts` is a single generated
 * `export *` barrel across every CRM module, so a generic name
 * (`Sequence`, `Enrollment`, `Step`) would collide.
 */

export {
  createSalesSequenceService,
  parseSalesSequenceCorrelationId,
  renderSalesSequenceTemplate,
  salesSequenceCorrelationId,
  SalesSequenceEnrollmentNotFoundError,
  SalesSequenceNotEnrollableError,
  SalesSequenceNotFoundError,
  SalesSequenceStepError,
  SalesSequenceSuppressedError,
  subscribeSalesSequenceExits,
  SALES_SEQUENCE_CORRELATION_PREFIX,
} from "./service"
export type { SalesSequenceInboundEnvelope, SalesSequenceService } from "./service"

export {
  assertSalesSequenceActorResolved,
  assertSalesSequenceStepAllowed,
  salesSequencePermission,
  salesSequenceStepPermission,
  SALES_SEQUENCE_ENROLLMENT_OBJECT,
  SALES_SEQUENCE_OBJECT,
  SALES_SEQUENCE_STEP_PERMISSIONS,
} from "./access"

export {
  createSalesSequenceSchema,
  describeSalesSequenceCatalogue,
  enrollInSalesSequenceSchema,
  isSalesSequenceInboundDirection,
  replaceSalesSequenceStepsSchema,
  salesSequenceCatalogueSchema,
  salesSequenceEmailStepSchema,
  salesSequenceEnrollmentQuerySchema,
  salesSequenceEnrollmentSchema,
  salesSequenceEnrollmentStatusSchema,
  salesSequenceExitReasonForEvent,
  salesSequenceExitReasonSchema,
  salesSequenceManualExitReasonSchema,
  salesSequenceQuerySchema,
  salesSequenceSchema,
  salesSequenceStatusSchema,
  salesSequenceStepDtoSchema,
  salesSequenceStepRunSchema,
  salesSequenceStepSchema,
  salesSequenceStepTypeSchema,
  salesSequenceTaskStepSchema,
  salesSequenceWaitStepSchema,
  stopSalesSequenceEnrollmentSchema,
  storedSalesSequenceEmailConfigSchema,
  storedSalesSequenceTaskConfigSchema,
  toSalesSequenceStepDraft,
  unsubscribeFromSalesSequencesSchema,
  updateSalesSequenceSchema,
  SALES_SEQUENCE_ENROLLMENT_STATUSES,
  SALES_SEQUENCE_EXIT_EVENTS,
  SALES_SEQUENCE_EXIT_REASONS,
  SALES_SEQUENCE_MAX_STEPS,
  SALES_SEQUENCE_MAX_WAIT_DAYS,
  SALES_SEQUENCE_MAX_WAIT_HOURS,
  SALES_SEQUENCE_STATUSES,
  SALES_SEQUENCE_STEP_TYPES,
} from "./schemas"
export type {
  CreateSalesSequenceInput,
  EnrollInSalesSequenceInput,
  ReplaceSalesSequenceStepsInput,
  SalesSequenceCatalogue,
  SalesSequenceDto,
  SalesSequenceEnrollmentDto,
  SalesSequenceEnrollmentQuery,
  SalesSequenceExitReasonValue,
  SalesSequenceQuery,
  SalesSequenceStatusValue,
  SalesSequenceStepDto,
  SalesSequenceStepInput,
  SalesSequenceStepRunDto,
  SalesSequenceStepTypeValue,
  StopSalesSequenceEnrollmentInput,
  StoredSalesSequenceEmailConfig,
  StoredSalesSequenceTaskConfig,
  UnsubscribeFromSalesSequencesInput,
  UpdateSalesSequenceInput,
} from "./schemas"

export type {
  SalesSequenceActorRoleResolver,
  SalesSequenceAuditInput,
  SalesSequenceContactRecord,
  SalesSequenceContactResolverPort,
  SalesSequenceEnrollmentListQuery,
  SalesSequenceEnrollmentListResult,
  SalesSequenceEnrollmentRecord,
  SalesSequenceEnrollmentWithRuns,
  SalesSequenceEnrollResult,
  SalesSequenceExitDecision,
  SalesSequenceExitResult,
  SalesSequenceExitTarget,
  SalesSequenceListQuery,
  SalesSequenceListResult,
  SalesSequenceRecord,
  SalesSequenceServiceContext,
  SalesSequenceServiceDeps,
  SalesSequenceStats,
  SalesSequenceStepDraft,
  SalesSequenceStepExecutorPort,
  SalesSequenceStepJobRequest,
  SalesSequenceStepOutcome,
  SalesSequenceStepQueuePort,
  SalesSequenceStepRecord,
  SalesSequenceStepRunRecord,
  SalesSequenceStepSkipReason,
  SalesSequenceStore,
  SalesSequenceWithSteps,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
