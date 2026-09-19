# 00 — Project Initialization / Main Page

## Purpose

This is the first specification an implementation agent reads. It defines how to create the initial YourCRM project from an empty repository and establish the application shell that every later page depends on.

## Goal

Create a production-ready TypeScript monorepo with:

- web application shell
- API service
- background worker
- PostgreSQL
- Redis
- object storage abstraction
- authentication foundation
- database migrations
- shared UI/design tokens
- environment configuration
- health checks
- seed data
- test infrastructure
- Docker Compose development environment
- CI pipeline
- documentation for coding agents

## Initial application routes

```text
/
 /login
 /signup
 /onboarding
 /app
 /app/dashboard
 /app/people
 /app/companies
 /app/leads
 /app/deals
 /app/activities
 /app/tasks
 /app/calendar
 /app/inbox
 /app/email
 /app/whatsapp
 /app/calling
 /app/products
 /app/quotes
 /app/invoices
 /app/tickets
 /app/knowledge-base
 /app/forms
 /app/automation
 /app/reports
 /app/analytics
 /app/search
 /app/import-export
 /app/integrations
 /app/ai
 /app/settings
```

The shell must support routes that are implemented later without requiring navigation rewrites.

## Recommended stack

- TypeScript end to end.
- React + Vite for the web app, unless the team deliberately chooses Next.js.
- Tailwind CSS + shadcn/ui.
- TanStack Query for server state.
- TanStack Table for dense data grids.
- PostgreSQL + JSONB.
- NestJS, Fastify or Hono for API.
- Redis + BullMQ for jobs.
- S3-compatible storage; MinIO for local/self-hosted.
- Vitest for unit/integration tests.
- Playwright for browser tests.
- pnpm workspaces + Turborepo.
- Docker Compose for local deployment.
- MCP TypeScript SDK for MCP server.
- pgvector for future AI retrieval.

## Repository initialization

Create:

```text
package.json
pnpm-workspace.yaml
turbo.json
.env.example
.gitignore
.editorconfig
.prettierrc
eslint.config.*
docker-compose.yml
Dockerfile
README.md
AGENTS.md
CLAUDE.md
LICENSE
apps/web
apps/api
apps/worker
packages/ui
packages/db
packages/auth
packages/config
packages/testing
docs/product
docs/architecture
```

## Environment configuration

At minimum:

- DATABASE_URL
- REDIS_URL
- STORAGE_ENDPOINT
- STORAGE_BUCKET
- STORAGE_ACCESS_KEY
- STORAGE_SECRET_KEY
- APP_URL
- API_URL
- SESSION_SECRET
- ENCRYPTION_KEY
- EMAIL provider settings
- OAuth provider settings
- optional AI provider keys
- optional WhatsApp/Twilio/Exotel settings

Validate environment variables at process startup. Never silently use production defaults in development.

## Application shell

Build:

- authenticated app layout
- left navigation
- workspace switcher
- team/user menu
- global search / command palette
- create button
- notifications center
- help/documentation entry
- breadcrumbs
- page header
- responsive mobile navigation
- keyboard shortcut overlay
- global toast system
- modal/drawer primitives
- confirmation dialog
- unsaved-change guard

## First-run experience

After the first successful login:

1. create workspace
2. choose company/workspace name
3. choose timezone and currency
4. optionally import data
5. optionally load sample data
6. create first pipeline
7. invite team
8. connect email/calendar
9. show dashboard

Provide a “skip for now” path.

## Database bootstrap

Create migration infrastructure and a health check that verifies:

- database reachable
- migrations current
- Redis reachable
- object storage reachable
- worker reachable where applicable

Use transaction-safe migrations.

## Seed data

Provide deterministic seed mode:

- sample workspace
- admin user
- second sales user
- sample companies
- sample people
- sample leads
- sample deals
- sample activities
- sample tasks
- sample pipeline

Seed data must be removable and clearly marked as demo data.

## Cross-cutting requirements

- Every API request has request/correlation ID.
- Structured logs.
- Centralized error format.
- API validation at boundaries.
- Pagination for collections.
- Cursor pagination for high-volume feeds.
- Rate limiting hooks.
- Audit-event hooks.
- Permission middleware hooks.
- Feature flag hooks.
- Soft-delete conventions.
- Created/updated timestamps.
- Actor metadata on mutations.

## Acceptance criteria

- Fresh clone can start with one documented command.
- Login works.
- New workspace can be created.
- App shell renders all placeholder routes.
- Database migrations run automatically.
- Seed data can be loaded.
- Health endpoint reports component status.
- Unit tests run from root.
- Playwright can launch a test workspace.
- Docker Compose starts all required local services.
- Another engineer can understand the repository from `AGENTS.md`.

## Agent handoff

This module is the foundation. Do not implement detailed CRM domain pages here. Other agents should be able to build against the shell and shared contracts without changing initialization code.
