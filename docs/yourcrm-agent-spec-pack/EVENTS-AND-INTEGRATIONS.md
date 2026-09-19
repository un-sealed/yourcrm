# Events & Integration Contracts

## Core events

### CRM
- `person.created`
- `person.updated`
- `person.merged`
- `company.created`
- `company.updated`
- `lead.created`
- `lead.qualified`
- `lead.converted`
- `deal.created`
- `deal.stage_changed`
- `deal.won`
- `deal.lost`
- `activity.created`
- `activity.completed`
- `task.created`
- `task.completed`

### Communications
- `email.received`
- `email.sent`
- `message.received`
- `message.sent`
- `call.completed`
- `calendar.event_synced`

### Automation
- `workflow.run_started`
- `workflow.step_failed`
- `workflow.completed`

### AI
- `ai.tool_called`
- `ai.action_requested`
- `ai.action_approved`
- `ai.action_reverted`
- `agent.completed`

## Event rules

- Version schemas.
- Include workspace and actor.
- Never include secrets.
- Consumers must be idempotent.
- Retry transient failures.
- Dead-letter permanent failures.
- Preserve ordering only where domain logic requires it.
