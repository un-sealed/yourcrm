export {
  AppAlreadyInstalledError,
  AppInstallationNotFoundError,
  AppKeyConflictError,
  createMarketplaceService,
  MarketplaceAppNotFoundError,
} from "./service"
export type { InstallAppResult, MarketplaceService } from "./service"
export {
  MARKETPLACE_APP_OBJECT,
  assertAppScopeGranted,
  partitionScopesByInstallerPermission,
} from "./access"
export {
  APP_UI_EXTENSION_POINTS,
  appInstallationSchema,
  appManifestSchema,
  appScopeGrantSchema,
  appScopeStringSchema,
  formatAppScope,
  installAppSchema,
  marketplaceAppQuerySchema,
  marketplaceAppSchema,
  parseAppScope,
  registerAppSchema,
} from "./schemas"
export type {
  AppInstallationDto,
  AppManifestInput,
  AppScopeGrantDto,
  AppScopeString,
  AppUiExtensionPoint,
  MarketplaceAppDto,
  MarketplaceAppQuery,
  RegisterAppInput,
} from "./schemas"
export { APP_INSTALLATION_STATUSES, MARKETPLACE_APP_STATUSES } from "./types"
export type {
  AppInstallation,
  AppInstallationListResult,
  AppInstallationStatusValue,
  AppInstallationStore,
  AppManifest,
  AppScope,
  AppScopeGrant,
  AppScopeGrantStore,
  AppUiExtensionDeclaration,
  AppWebhookDeclaration,
  MarketplaceApp,
  MarketplaceAppListQuery,
  MarketplaceAppListResult,
  MarketplaceAppStatusValue,
  MarketplaceAppStore,
  MarketplaceAuditInput,
  MarketplaceServiceContext,
  MarketplaceServiceDeps,
} from "./types"
// Shared across every CRM module — see ../ports.ts for why they live there.
export type { AuditWriter, EventEmitter } from "../ports"
