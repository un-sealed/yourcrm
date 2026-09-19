/**
 * Conversation Intelligence module (spec 37, P0).
 *
 * Reads conversations owned by Email (14), WhatsApp (16) and Calling (17)
 * and produces four kinds of structured output — summary, sentiment,
 * action items, key topics — each stored with full attribution and each
 * readable exactly when the conversation it describes is readable.
 *
 * It owns two tables (`conversation_analyses`, `call_transcripts`) and
 * writes to nothing else: an extracted action item becomes a task only
 * through spec 38's approval queue, never from here.
 *
 * Every export is prefixed `Conversation`/`CallTranscript`/`conversation`
 * on purpose: `../index.ts` is a single generated `export *` barrel across
 * all CRM modules, so `Analysis`, `Transcript`, `Segment` or `Source`
 * would collide on sight.
 */

export {
  createConversationIntelligenceService,
  conversationAnalysisAuditPayload,
  ConversationActionItemNotFoundError,
  ConversationAnalysisFailedError,
  ConversationAnalysisNotFoundError,
  ConversationAnalysisQueueUnavailableError,
  ConversationGovernanceUnavailableError,
  ConversationSourceEmptyError,
  ConversationSourceUnavailableError,
  ConversationSubjectNotFoundError,
  CONVERSATION_ACTION_ITEM_OBJECT_TYPE,
  CONVERSATION_INTELLIGENCE_AGENT_ID,
  CONVERSATION_RESPONSE_TRUNCATED_CODE,
} from "./service"
export type { ConversationIntelligenceService } from "./service"

export {
  canReadConversationSubjectType,
  conversationPermission,
  conversationSubjectPermission,
  readableConversationSubjectTypes,
  CALL_TRANSCRIPT_OBJECT,
  CONVERSATION_ANALYSIS_OBJECT,
  CONVERSATION_SUBJECT_PERMISSION_OBJECTS,
} from "./access"

export {
  boundConversationSource,
  boundConversationText,
  conversationSourceToText,
  estimateConversationTokens,
  formatConversationTurn,
  CONVERSATION_ANALYSIS_MAX_OUTPUT_TOKENS,
  CONVERSATION_ANALYSIS_MAX_SOURCE_CHARS,
  CONVERSATION_ANALYSIS_MAX_TYPES_PER_REQUEST,
  CONVERSATION_CHARS_PER_TOKEN,
} from "./bounds"
export type { BoundedConversationText } from "./bounds"

export {
  buildConversationAnalysisMessages,
  buildConversationAnalysisSystemPrompt,
  conversationActionItemsOf,
  conversationBulletLines,
  extractJsonObject,
  isEmptyConversationAnalysisOutput,
  parseConversationAnalysisOutput,
  CONVERSATION_SENTIMENT_CAVEAT,
  CONVERSATION_SENTIMENT_LABELS,
} from "./prompt"
export type {
  ConversationActionItemsOutput,
  ConversationAnalysisOutput,
  ConversationKeyTopicsOutput,
  ConversationSentimentLabel,
  ConversationSentimentOutput,
  ConversationSummaryOutput,
} from "./prompt"

export {
  containsConversationContent,
  containsConversationTerms,
  redactConversationContent,
  redactConversationTerms,
  MIN_TERM_LENGTH,
  REDACTED_MESSAGE_MAX_CHARS,
  REDACTION_PLACEHOLDER,
  REDACTION_WINDOW,
} from "./redaction"

export {
  callTranscriptSpeakers,
  callTranscriptTextFromSegments,
  callTranscriptToConversationTurns,
  formatTranscriptOffset,
  normalizeCallTranscriptSegments,
  CALL_TRANSCRIPT_MAX_CHARS,
  CALL_TRANSCRIPT_MAX_SEGMENTS,
  CALL_TRANSCRIPT_MAX_SEGMENT_CHARS,
} from "./transcript"
export type { CallTranscriptSegment } from "./transcript"

export {
  createCallTranscriptConversationSource,
  createConversationSource,
  createConversationSourceRegistry,
} from "./sources"
export type {
  CallTranscriptConversationSourceDeps,
  ConversationSubjectReader,
  ConversationSubjectReading,
} from "./sources"

export {
  callTranscriptSchema,
  callTranscriptSegmentSchema,
  callTranscriptSourceSchema,
  conversationAnalysisQuerySchema,
  conversationAnalysisSchema,
  conversationAnalysisStatusSchema,
  conversationAnalysisTypeSchema,
  conversationIntelligenceStatusSchema,
  conversationSubjectRefSchema,
  conversationSubjectTypeSchema,
  ingestCallTranscriptSchema,
  proposeConversationActionItemSchema,
  requestConversationAnalysisSchema,
} from "./schemas"
export type {
  CallTranscriptDto,
  CallTranscriptSegmentInput,
  ConversationAnalysisDto,
  ConversationAnalysisQuery,
  ConversationIntelligenceStatusDto,
  ConversationSubjectRef,
  IngestCallTranscriptInput,
  ProposeConversationActionItemInput,
  RequestConversationAnalysisInput,
} from "./schemas"

export {
  isConversationSubjectTypeName,
  CALL_TRANSCRIPT_SOURCE_NAMES,
  CONVERSATION_ANALYSIS_STATUS_NAMES,
  CONVERSATION_ANALYSIS_TYPE_NAMES,
  CONVERSATION_SUBJECT_TYPE_NAMES,
} from "./types"
export type {
  CallTranscriptInsert,
  CallTranscriptRecord,
  CallTranscriptSource,
  ConversationActionItem,
  ConversationAnalysisDetail,
  ConversationAnalysisInsert,
  ConversationAnalysisJob,
  ConversationAnalysisListQuery,
  ConversationAnalysisListResult,
  ConversationAnalysisPatch,
  ConversationAnalysisQueuePort,
  ConversationAnalysisRecord,
  ConversationAnalysisStatus,
  ConversationAnalysisSubject,
  ConversationAnalysisType,
  ConversationIntelligenceAuditInput,
  ConversationIntelligenceServiceContext,
  ConversationIntelligenceServiceDeps,
  ConversationIntelligenceStore,
  ConversationSource,
  ConversationSourcePort,
  ConversationSourceRegistry,
  ConversationSubjectType,
  ConversationTurn,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
