/**
 * Settings, security & compliance module (specs 40 + 41, P0).
 *
 * Every export is prefixed (`WorkspaceTeam`, not `Team`; `WorkspaceSettings`,
 * not `Settings`) because `packages/crm/src/index.ts` is one generated
 * `export *` barrel over two dozen modules.
 */
export {
  createWorkspaceSettingsService,
  WorkspaceInviteConflictError,
  WorkspaceInviteNotFoundError,
  WorkspaceMemberNotFoundError,
  WorkspaceSettingsNotFoundError,
} from "./service"
export type { WorkspaceSettingsService } from "./service"

export {
  createWorkspaceTeamService,
  WorkspaceTeamMembershipError,
  WorkspaceTeamNotFoundError,
} from "./teams-service"
export type { WorkspaceTeamService } from "./teams-service"

export {
  createComplianceService,
  DataRequestKindError,
  DataRequestNotFoundError,
  DataSubjectNotFoundError,
} from "./compliance-service"
export type { ComplianceService, DataSubjectExport } from "./compliance-service"

export {
  checkInviteUsable,
  checkWorkspaceInviteRole,
  checkWorkspaceMemberActivation,
  checkWorkspaceRoleChange,
  isWorkspaceMemberRoleName,
  workspaceRoleRank,
  WORKSPACE_MEMBER_ROLES,
} from "./roles"
export type {
  InviteRoleAttempt,
  MemberActivationAttempt,
  RoleChangeAttempt,
  RoleGuardActor,
  RoleGuardTarget,
  RoleGuardVerdict,
  WorkspaceMemberRoleName,
} from "./roles"

export {
  dataRequestCreateSchema,
  dataRequestQuerySchema,
  dataRequestSchema,
  workspaceAuditQuerySchema,
  workspaceAuditSchema,
  workspaceInviteCreateSchema,
  workspaceInviteQuerySchema,
  workspaceInviteSchema,
  workspaceMemberQuerySchema,
  workspaceMemberRolePatchSchema,
  workspaceMemberSchema,
  workspaceRoleSchema,
  workspaceSettingsPatchSchema,
  workspaceSettingsSchema,
  workspaceTeamCreateSchema,
  workspaceTeamMemberAddSchema,
  workspaceTeamPatchSchema,
  workspaceTeamQuerySchema,
  workspaceTeamSchema,
  WORKSPACE_ROLE_VALUES,
} from "./schemas"
export type {
  DataRequestCreateInput,
  DataRequestQueryInput,
  WorkspaceAuditQueryInput,
  WorkspaceInviteCreateInput,
  WorkspaceInviteQueryInput,
  WorkspaceMemberQueryInput,
  WorkspaceMemberRolePatchInput,
  WorkspaceRoleValue,
  WorkspaceSettingsPatchInput,
  WorkspaceTeamCreateInput,
  WorkspaceTeamMemberAddInput,
  WorkspaceTeamPatchInput,
  WorkspaceTeamQueryInput,
} from "./schemas"

export type {
  ComplianceServiceDeps,
  DataRequestRecord,
  DataRequestStore,
  DataSubjectPort,
  SettingsAuditInput,
  SettingsPage,
  SettingsServiceContext,
  WorkspaceAuditLogPort,
  WorkspaceAuditQuery,
  WorkspaceAuditRecord,
  WorkspaceInviteRecord,
  WorkspaceInviteStore,
  WorkspaceInviteTokenPort,
  WorkspaceMemberQuery,
  WorkspaceMemberRecord,
  WorkspaceMemberStore,
  WorkspaceProfileStore,
  WorkspaceSettingsPatch,
  WorkspaceSettingsRecord,
  WorkspaceSettingsServiceDeps,
  WorkspaceTeamMemberRecord,
  WorkspaceTeamRecord,
  WorkspaceTeamServiceDeps,
  WorkspaceTeamStore,
} from "./types"
