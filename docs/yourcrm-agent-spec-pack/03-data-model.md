# 03 — Core Data Model & Custom Objects

## Goal

Create the flexible CRM data foundation used by every feature.

## Default objects

- Workspace
- User
- Team
- Person
- Company
- Lead
- Deal
- Pipeline
- PipelineStage
- Activity
- Task
- Note
- File
- Tag
- Relationship
- CustomObject
- CustomField
- SavedView
- AuditEvent
- Notification

## Core record conventions

Every record should support:

- id
- workspace_id
- created_at
- updated_at
- created_by
- updated_by
- owner_id where applicable
- deleted_at
- custom fields
- tags
- relationships
- audit metadata

## Custom fields

Support:

- text
- long text
- number
- currency
- percentage
- date
- datetime
- duration
- select
- multi-select
- boolean
- URL
- email
- phone
- file
- image
- rating
- relation
- formula
- lookup
- rollup
- AI-generated

## Relationships

Support:

- one-to-one
- one-to-many
- many-to-many
- polymorphic references where needed

Relationship metadata should support labels, ordering and reciprocal display.

## Validation

Support:

- required
- min/max
- regex
- unique
- allowed values
- conditional validation
- duplicate prevention

## Custom objects

Admin can create objects without code migrations. Configure:

- name
- plural name
- icon
- fields
- relationships
- permissions
- default views
- search behavior
- timeline support
- activity support
- automation triggers

## Formula/rollup/lookup

Later P1/P2 support:

- arithmetic
- conditional formulas
- related-record aggregation
- lookup fields

Never execute arbitrary SQL from formula fields.

## Acceptance criteria

- Default objects migrate cleanly.
- Custom fields can be added without application redeploy.
- Custom objects can be created from UI.
- Relationships work across default and custom objects.
- Soft delete and audit hooks work consistently.
