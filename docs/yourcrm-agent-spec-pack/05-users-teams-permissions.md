# 05 — Users, Teams & Permissions

## Goal
Provide the access-control model shared by every CRM module.

## Features
- Invite users.
- Deactivate/reactivate users.
- Teams and nested teams.
- Roles.
- Object permissions: read/create/edit/delete.
- Record visibility: own/team/all.
- Field-level read/write.
- Assignment permissions.
- Export permission.
- API key scopes.
- AI agent scopes.
- Channel permissions.
- Admin/member roles.
- Bulk role assignment.
- User activity summary.
- Session management.
- Invitation expiry/resend.

## Permission model

```text
workspace
  → object
    → record
      → field
        → action
```

Actions:
`read`, `create`, `update`, `delete`, `export`, `share`, `send_external`, `run_automation`, `run_ai`, `admin`.

## Acceptance criteria
- Every module can call one shared permission service.
- Permission-negative tests exist.
- UI visibility never replaces server-side authorization.
- AI and MCP cannot exceed the authenticated user's effective permissions.
