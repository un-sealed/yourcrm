export {
  PipelineNotFoundError,
  PipelineStageNotFoundError,
  createPipelineSchema,
  createPipelinesService,
  createStageSchema,
  pipelineQuerySchema,
  pipelineSchema,
  pipelineStageInputSchema,
  pipelineStageSchema,
  reorderStagesSchema,
  updatePipelineSchema,
  updateStageSchema,
} from "./service"
export type {
  CreatePipelineInput,
  CreateStageInput,
  PipelineDto,
  PipelineQuery,
  PipelineStageDto,
  PipelinesService,
  ReorderStagesInput,
  UpdatePipelineInput,
  UpdateStageInput,
} from "./service"
export type {
  PipelineAuditInput,
  PipelineListQuery,
  PipelineListResult,
  PipelineRecord,
  PipelineStageRecord,
  PipelinesServiceContext,
  PipelinesServiceDeps,
  PipelinesStore,
  PipelineWithStages,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
