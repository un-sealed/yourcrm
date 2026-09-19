# YourCRM — Technology Stack

## 1. Core Runtime

| Layer | Technology | Purpose |
|---|---|---|
| Runtime | **Bun** | JavaScript/TypeScript runtime, package manager, test runner |
| Language | **TypeScript** | Primary development language |
| Monorepo | **Bun Workspaces + Turborepo** | Manage applications and shared packages |

## 2. Web Application

| Layer | Technology | Purpose |
|---|---|---|
| Framework | **Next.js** | CRM web application |
| UI | **React** | Component architecture |
| Styling | **Tailwind CSS** | Utility-first styling |
| Components | **shadcn/ui** | Accessible reusable UI components |
| Server state | **TanStack Query** | API/server state management |
| Client state | **Zustand** | Local/client state |
| Tables | **TanStack Table** | Spreadsheet-style CRM tables |
| Forms | **React Hook Form** | Form management |
| Validation | **Zod** | Runtime/type-safe validation |

The web application should remain primarily responsible for UI and user experience. Business logic must live in shared application/domain packages or the API layer rather than inside React components.

## 3. Backend API

| Layer | Technology | Purpose |
|---|---|---|
| Runtime | **Bun** | Backend runtime |
| HTTP framework | **Hono** | API routing and middleware |
| Language | **TypeScript** | Backend development |
| API style | **REST** | Primary API interface |
| API specification | **OpenAPI** | API documentation and contracts |
| Validation | **Zod** | Request/response validation |
| Authentication | **Better Auth** | Authentication/session management |

### Backend principle

Hono should remain a **thin HTTP layer**.

Routes should handle HTTP requests, authentication context, request validation, response serialization, and HTTP-specific errors.

Routes must NOT contain substantial business logic.

```text
HTTP Request
     ↓
Hono Route
     ↓
Validation
     ↓
Permission Check
     ↓
Application Service
     ↓
Repository
     ↓
PostgreSQL
```

Do not create a large framework-specific architecture around Hono. Use normal TypeScript modules, functions, services, repositories, policies, and domain packages.

## 4. Database

| Layer | Technology | Purpose |
|---|---|---|
| Database | **PostgreSQL** | Primary database |
| ORM/query builder | **Drizzle ORM** | Type-safe database access |
| Vector search | **pgvector** | AI embeddings/vector search |
| Full-text search | **PostgreSQL FTS** | Initial application search |
| Fuzzy search | **PostgreSQL pg_trgm** | Fuzzy/name matching |

PostgreSQL is the primary source of truth.

Use PostgreSQL JSONB for custom fields, integration metadata, workflow configuration, AI metadata, and flexible configuration.

Do not create a separate database for every CRM object.

## 5. Background Jobs

| Layer | Technology | Purpose |
|---|---|---|
| Queue | **Redis** | Queue/cache infrastructure |
| Job system | **BullMQ** | Background jobs and workers |
| Runtime | **Bun** | Worker runtime |

Workers handle email synchronization, imports, exports, AI processing, embeddings, notifications, webhook processing, workflow execution, scheduled tasks, WhatsApp processing, calling events, report generation, and file processing.

Do not introduce Temporal initially. Evaluate Temporal later if workflows require durable, long-running orchestration beyond what BullMQ can comfortably handle.

## 6. Object Storage

| Layer | Technology | Purpose |
|---|---|---|
| Storage API | **S3-compatible API** | File storage abstraction |
| Self-hosted storage | **MinIO** | Local/self-hosted deployment |
| Cloud storage | **Amazon S3 / compatible providers** | Production deployments |

Store attachments, documents, images, exported files, generated PDFs, email attachments, and AI-generated artifacts.

Do not store large binary files directly inside PostgreSQL.

## 7. Realtime

| Layer | Technology | Purpose |
|---|---|---|
| Transport | **WebSocket** | Realtime communication |
| Infrastructure | **Redis** | Pub/sub and coordination |

Realtime functionality includes notifications, record updates, collaborative editing, presence, activity updates, workflow status, AI task progress, import/export progress, and inbox updates.

Use a simple WebSocket architecture initially. Add Yjs only where true collaborative editing requires it.

## 8. Search

### Phase 1

Use PostgreSQL:

```text
PostgreSQL FTS
+
pg_trgm
+
structured filters
```

Search people, companies, leads, deals, tasks, activities, notes, and custom objects.

### Phase 2

Introduce **Typesense** when search requirements outgrow PostgreSQL.

Do not introduce Elasticsearch/OpenSearch unless there is a demonstrated requirement.

## 9. AI

| Layer | Technology | Purpose |
|---|---|---|
| AI abstraction | **Vercel AI SDK** | Unified AI application layer |
| Providers | OpenAI | Cloud LLM |
| Providers | Anthropic | Cloud LLM |
| Providers | Google Gemini | Cloud LLM |
| Providers | OpenRouter | Multi-provider access |
| Local models | Ollama | Local/self-hosted AI |
| Local models | vLLM | Self-hosted inference |
| Embeddings | Provider/local models | Vector search |

AI functionality should live under:

```text
packages/ai/
├── providers/
├── assistant/
├── agents/
├── tools/
├── embeddings/
├── extraction/
├── classification/
├── conversation/
├── prompts/
├── governance/
└── costs/
```

AI must never bypass normal CRM permissions.

## 10. MCP

Use the **official TypeScript MCP SDK**.

MCP should be a first-class application:

```text
apps/
└── mcp/
```

MCP tools must use the same authentication, workspace, user, permissions, and tool policy layers as the normal application.

MCP must NOT directly access database tables to perform user actions.

Example tools:

```text
search_people
get_person
create_person
update_person

search_companies
get_company
create_company
update_company

search_deals
get_deal
create_deal
update_deal

create_task
complete_task

search_activities
create_activity

search_notes
create_note
```

## 11. Mobile

| Layer | Technology | Purpose |
|---|---|---|
| Framework | **Expo** | Mobile application |
| UI | **React Native** | Native UI |
| Language | **TypeScript** | Mobile development |
| State | **TanStack Query + Zustand** | Server/client state |

The mobile application should use the same API and domain contracts as the web application.

## 12. Testing

| Layer | Technology |
|---|---|
| Unit tests | **Bun Test / Vitest** |
| API/integration tests | **Bun Test / Vitest** |
| E2E | **Playwright** |
| Type checking | **TypeScript** |
| API contract | **OpenAPI** |

Every CRM module should have unit tests, service/application tests, API tests where applicable, and E2E tests for critical user flows.

## 13. Deployment

### Development / Self-hosting

Use **Docker Compose**.

Services:

```text
yourcrm-web
yourcrm-api
yourcrm-worker
yourcrm-mcp
postgres
redis
minio
```

Optional:

```text
typesense
```

### Production

Support Docker, Kubernetes, Helm, and Terraform.

The application must remain fully usable without Kubernetes.

## 14. CI/CD

Use **GitHub Actions**.

CI should run:

```text
Install
  ↓
Typecheck
  ↓
Lint
  ↓
Unit Tests
  ↓
Integration Tests
  ↓
Build
  ↓
E2E Tests
```

Container images should be buildable independently for web, api, worker, and mcp.

# 15. Monorepo Architecture

```text
yourcrm/
│
├── apps/
│   ├── web/                 # Next.js
│   ├── api/                 # Hono + Bun
│   ├── worker/              # Bun + BullMQ
│   ├── mcp/                 # MCP server
│   └── mobile/              # Expo
│
├── packages/
│   ├── ui/
│   ├── database/
│   ├── auth/
│   ├── permissions/
│   ├── crm/
│   ├── search/
│   ├── ai/
│   ├── agents/
│   ├── workflows/
│   ├── events/
│   ├── integrations/
│   ├── storage/
│   ├── notifications/
│   ├── validation/
│   └── config/
│
├── infrastructure/
│   ├── docker/
│   ├── k8s/
│   └── terraform/
│
└── docs/
    └── specs/
```

# 16. Architectural Principle

YourCRM should use a:

> **Modular monolith + background workers architecture.**

Do NOT start with microservices.

```text
                    ┌───────────────┐
                    │    Next.js    │
                    │      Web      │
                    └───────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
                    │ Hono + Bun API│
                    └───────┬───────┘
                            │
             ┌──────────────┼──────────────┐
             ▼              ▼              ▼
        PostgreSQL        Redis       Object Storage
             │              │
             │              ▼
             │          BullMQ
             │              │
             │              ▼
             │         Bun Workers
             │              │
             ▼              ▼
          pgvector       AI / Integrations
```

The architecture should optimize for:

1. Developer simplicity
2. Open-source contribution
3. Self-hosting
4. Type safety
5. Modularity
6. AI extensibility
7. MCP integration
8. Long-term maintainability

**Locked backend decision: `Bun + Hono`.**
