export {
  AiConversationNotFoundError,
  buildAiSystemPrompt,
  computeAiCostMicros,
  createAiAssistantService,
  deriveAiConversationTitle,
} from "./service"
export type { AiAssistantService } from "./service"
export {
  AI_CONVERSATION_OBJECT,
  AI_RUN_OBJECT,
  AI_TOOL_CALL_OBJECT,
  aiConversationOwnerId,
  aiPermission,
  assertAiConversationVisible,
  resolveAiConversationScope,
} from "./access"
export {
  AI_TOOL_DESCRIBE_OBJECTS,
  AI_TOOL_QUERY,
  AiWriteToolNotAllowedError,
  createAiCrmTools,
  createAiDescribeObjectsTool,
  createAiQueryTool,
  createAiToolRegistry,
} from "./tools"
export {
  AI_MESSAGE_MAX_LENGTH,
  aiConversationQuerySchema,
  aiConversationSchema,
  aiMessageSchema,
  aiProviderStatusSchema,
  aiQueryFilterSchema,
  aiQueryToolArgsSchema,
  aiRunSchema,
  askAiSchema,
  createAiConversationSchema,
  updateAiConversationSchema,
} from "./schemas"
export type {
  AiConversationDto,
  AiConversationQuery,
  AiMessageDto,
  AiProviderStatusDto,
  AiQueryToolArgs,
  AiRunDto,
  AskAiInput,
  CreateAiConversationInput,
  UpdateAiConversationInput,
} from "./schemas"
export {
  AI_PROVIDER_ERROR_CODE_VALUES,
  AiProviderRequestError,
  OPENAI_COMPATIBLE_AI_PROVIDER_ID,
  createOpenAiCompatibleAiProvider,
} from "./providers/openai-compatible-ai-provider"
export type {
  AiProviderErrorCodeValue,
  OpenAiCompatibleAiProviderConfig,
} from "./providers/openai-compatible-ai-provider"
export {
  STUB_AI_MODEL,
  STUB_AI_PROVIDER_ID,
  createStubAiProvider,
} from "./providers/stub-ai-provider"
export type {
  StubAiCall,
  StubAiProvider,
  StubAiProviderOptions,
  StubAiScriptStep,
} from "./providers/stub-ai-provider"
export { AI_MESSAGE_ROLES, AI_RUN_OUTCOMES } from "./types"
export type {
  AiAskResult,
  AiAssistantServiceContext,
  AiAssistantServiceDeps,
  AiAssistantStore,
  AiAuditInput,
  AiCompleteOptions,
  AiCompletionResult,
  AiConversationDetail,
  AiConversationListQuery,
  AiConversationListResult,
  AiConversationRecord,
  AiConversationScope,
  AiFinishReasonValue,
  AiMessageInsert,
  AiMessageRecord,
  AiMessageRoleValue,
  AiModelPrice,
  AiModelPricingTable,
  AiProviderMessage,
  AiProviderPort,
  AiProviderStatus,
  AiProviderToolCall,
  AiProviderToolDefinition,
  AiReportQueryPort,
  AiRunInsert,
  AiRunOutcomeValue,
  AiRunRecord,
  AiTokenUsage,
  AiTool,
  AiToolCallReport,
  AiToolContext,
  AiToolExecution,
  AiToolRegistry,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
