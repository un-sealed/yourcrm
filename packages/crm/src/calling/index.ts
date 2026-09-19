export {
  AmbiguousCallingConnectionError,
  CallNotFoundError,
  CallingConnectionNotConnectedError,
  CallingConnectionNotFoundError,
  CallingProviderCallFailedError,
  CallingProviderNotRegisteredError,
  MissingCallerIdError,
  NoCallingProviderConnectedError,
  RecordingConsentRequiredError,
  createCallingService,
} from "./service"
export type {
  ApplyProviderStatusEventInput,
  ApplyProviderStatusEventResult,
  CallingService,
} from "./service"

export {
  CONSOLE_CALLING_PROVIDER_ID,
  consoleCallingConfigSchema,
  createCallingProviderCatalog,
  createConsoleCallingProvider,
} from "./provider"
export type { ConsoleCallingProviderOptions, ConsoleCallStatusEvent } from "./provider"

export { InvalidPhoneNumberError, isE164, normalizeE164 } from "./phone"
export type { NormalizePhoneOptions } from "./phone"

export {
  CALL_STATUSES,
  TERMINAL_CALL_STATUSES,
  decideCallStatusTransition,
  isCallStatus,
  isTerminalCallStatus,
} from "./status"
export type { CallStatus, CallStatusTransitionDecision } from "./status"

export {
  addCallRecordingSchema,
  callQuerySchema,
  callRecordingSchema,
  callSchema,
  logCallSchema,
  placeCallSchema,
  updateCallSchema,
} from "./schemas"
export type {
  AddCallRecordingInput,
  CallDto,
  CallQuery,
  CallRecordingDto,
  LogCallInput,
  PlaceCallInput,
  UpdateCallInput,
} from "./schemas"

export type {
  CallAuditInput,
  CallingConnectionLookupPort,
  CallingConnectionRecord,
  CallingCredentialReadPort,
  CallingProviderCatalogPort,
  CallingProviderPort,
  CallingServiceContext,
  CallingServiceDeps,
  CallingStore,
  CallListQuery,
  CallListResult,
  CallRecord,
  CallRecordingRecord,
  CallRecordingStore,
  PlaceCallProviderResult,
} from "./types"

// Shared across every CRM module — see ../ports.ts for why they live here.
export type { AuditWriter, EventEmitter } from "../ports"
