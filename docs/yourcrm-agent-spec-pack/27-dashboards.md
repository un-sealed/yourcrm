# Dashboards

## 1. Purpose
Personal/team executive and operational dashboards.

## 2. Routes
/app/dashboard, /app/dashboards, /app/dashboards/:id

## 3. Scope / Feature Checklist
- [ ] Default sales dashboard.
- [ ] Custom dashboard creation.
- [ ] Drag/drop widgets.
- [ ] KPI, chart, table, funnel and activity widgets.
- [ ] Date/filter controls.
- [ ] Team/user scope.
- [ ] Saved dashboard views.
- [ ] Share dashboards.
- [ ] Scheduled snapshots.
- [ ] Dashboard drill-down into records.
- [ ] AI daily briefing widget.
- [ ] Mobile responsive dashboard cards.

## 4. UX / Page Structure

### List / workspace
- Page header with title, primary create action, search and saved-view controls.
- Table/list/board appropriate to this module.
- Filter builder with AND/OR groups.
- Sort, group, column/layout customization.
- Bulk-selection and bulk-action toolbar.
- Empty state explaining the first useful action.
- Loading skeletons that preserve layout.
- Recoverable error state with retry.
- Confirmation for destructive/bulk operations.

### Detail
- Record header with title, status, owner and primary actions.
- Properties grouped into logical sections.
- Related records.
- Unified activity timeline where applicable.
- Attachments/files where applicable.
- Internal comments/mentions where applicable.
- Audit/change history where applicable.
- Contextual AI actions where enabled.

### Create/Edit
- Progressive form: required fields first, advanced fields collapsible.
- Client and server validation.
- Duplicate check before final creation.
- Unsaved-change warning.
- Keyboard shortcuts for save/cancel.
- Optimistic UI only where safe.

## 5. Core Workflows
1. Create a record.
2. Search and open a record.
3. Edit a record.
4. Relate it to other records.
5. Add activity/task/file.
6. Perform a bulk operation.
7. Filter and save a view.
8. Export where permitted.
9. Restore from trash where supported.
10. Review audit history.
11. Use relevant automation.
12. Use relevant AI capability with human control.

## 6. Data Model
Dashboard, DashboardWidget, DashboardFilter.

All records must follow the shared conventions in `03-data-model.md`.

## 7. API Requirements
CRUD, widget query, share, snapshot.

Every API must use the conventions in `01-architecture.md`: validation, pagination, permission checks, correlation IDs, consistent errors, idempotency where relevant and audit events.

## 8. Permissions
dashboard ownership/share plus underlying data permissions.

Permission checks must occur server-side. UI hiding is not a security boundary.

## 9. Domain Events
dashboard.created, dashboard.updated.

Events must include workspace, actor, entity, timestamp, correlation ID and schema version.

## 10. Automation Hooks
The module must expose relevant triggers for:
- record created
- record updated
- important status changes
- scheduled conditions where meaningful
- inbound integration events
- explicit user actions

The module must be callable from the workflow engine without duplicating business rules.

## 11. Search / Filters / Bulk
- Full-text and structured search.
- Filter by all important fields.
- AND/OR filter groups.
- Saved personal/shared views.
- Bulk edit, assign, tag and archive/delete where safe.
- Export only records visible to the current actor.
- Large operations run as background jobs with progress.

## 12. Import / Export
Implement CSV/Excel mapping where applicable. Support dry-run, validation, duplicate detection and background processing. Exports must obey permissions.

## 13. Notifications
Trigger notifications only for meaningful events. Support in-app first, then email/push where configured. Respect user preferences and quiet hours.

## 14. AI Capabilities
Use AI only where it improves the workflow. Every AI write:
- inherits user permissions
- shows what will change
- is attributable to a model/run
- can require approval
- is logged
- is reversible when technically possible

## 15. Mobile / PWA
Provide a compact mobile layout and expose the module's highest-frequency actions as quick actions. Avoid desktop-only hover interactions.

## 16. Accessibility
Keyboard support, focus states, labels, semantic controls, screen-reader announcements and accessible status indicators are required.

## 17. Security / Privacy
- Validate all inputs server-side.
- Enforce tenant/workspace isolation.
- Avoid leaking private fields through search, exports or AI.
- Audit sensitive actions.
- Respect retention/consent policies.
- Never log secrets or message content unnecessarily.

## 18. Observability
Log important mutations, integration failures and background jobs with correlation IDs. Add metrics for latency, failures and volume where practical.

## 19. Testing
Required:
- unit tests for domain rules
- API tests for permissions and validation
- integration tests for persistence
- Playwright test for the primary workflow
- duplicate/merge tests where relevant
- permission-negative tests
- mobile viewport test for primary workflow

## 20. Acceptance Criteria
A manager can assemble a useful dashboard without code.

Additionally:
- No critical workflow can bypass permissions.
- Empty/loading/error states are implemented.
- Audit events are generated for important writes.
- The module is usable without knowledge of internal IDs.
- The module does not duplicate shared components or auth/permission logic.

## 21. Priorities

### P0
Core CRUD, search, permissions, timeline/relationships where applicable, responsive UI, tests and auditability.

### P1
Automation, integrations, AI assistance, advanced analytics and productivity features listed above.

### P2
Advanced intelligence, marketplace, offline/native and enterprise-scale features.

## 22. Agent Handoff

### Read first
- `00-project-initialization.md`
- `01-architecture.md`
- `02-design-system.md`
- `03-data-model.md`
- `04-authentication.md`
- `05-users-teams-permissions.md`

### Dependencies
Use the dependency map in `AGENT-DEPENDENCIES.md`.

### Build
Implement only this module plus narrowly required shared primitives.

### Do not
- rewrite authentication
- create a second permission system
- create duplicate UI primitives
- directly access another module's tables without its service/repository contract
- bypass domain events
- introduce a second state-management approach

### Deliverables
- UI routes
- API endpoints
- DB migration/model changes
- domain services
- events
- tests
- seed/demo data if useful
- concise developer documentation
