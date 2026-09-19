export {
  NoSampleDataError,
  ONBOARDING_STEPS,
  SampleDataUnavailableError,
  createOnboardingService,
} from "./service"
export type {
  OnboardingProgressResult,
  OnboardingService,
  OnboardingStepDefinition,
  OnboardingStepResult,
} from "./service"
export {
  ONBOARDING_STEP_KEYS,
  onboardingActionSchema,
  onboardingProgressSchema,
  onboardingStepKeySchema,
  onboardingStepSchema,
} from "./schemas"
export type {
  OnboardingActionInput,
  OnboardingProgressDto,
  OnboardingStepDto,
  OnboardingStepKey,
} from "./schemas"
export type {
  OnboardingAuditInput,
  OnboardingProgressRecord,
  OnboardingServiceContext,
  OnboardingServiceDeps,
  OnboardingSignals,
  OnboardingStore,
  SampleDataPort,
  SampleDataRecord,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
