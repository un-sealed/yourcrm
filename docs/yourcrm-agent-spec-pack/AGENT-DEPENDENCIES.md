# Agent Dependency Map

## Foundation order

```text
00 Project Initialization
   ├── 01 Architecture
   ├── 02 Design System
   ├── 03 Data Model
   ├── 04 Authentication
   └── 05 Users/Teams/Permissions
          ↓
   Core CRM
   ├── People
   ├── Companies
   ├── Leads
   ├── Deals
   ├── Pipelines
   ├── Activities
   └── Tasks
          ↓
   Communication
   ├── Calendar
   ├── Email
   ├── Unified Inbox
   ├── WhatsApp
   └── Calling
          ↓
   Revenue / Operations
   ├── Products
   ├── Quotes
   ├── Invoices
   ├── Forms
   ├── Sales Engagement
   ├── Automation
   ├── Reports
   └── Dashboards
          ↓
   Platform
   ├── Search
   ├── Files
   ├── Import/Export
   ├── Integrations
   ├── API/Webhooks
   └── Custom Objects/Fields
          ↓
   AI
   ├── Assistant
   ├── AI Fields/Data Capture
   ├── Agents
   ├── Conversation Intelligence
   ├── Governance
   └── MCP
          ↓
   Advanced
   ├── Support
   ├── Knowledge Base
   ├── Customer Portal
   ├── Customer Success
   ├── Mobile/PWA
   ├── Marketplace SDK
   └── Observability/Backups
```

## Parallelization

After foundation contracts are stable, these can be developed in parallel:

- People
- Companies
- Leads
- Deals
- Tasks
- Calendar
- Email
- Forms
- Search
- Files
- Import/Export

AI agents should consume stable APIs/events instead of reaching directly into domain tables.

## Shared contracts to freeze early

- ID format
- workspace/tenant isolation
- user/team/role model
- permission API
- pagination
- error schema
- event envelope
- file reference
- relationship reference
- audit event
- notification event
- AI tool permission model
