# Marketplace / Plugin SDK

Developer guide for **P0** of the marketplace/app SDK: how to author an app
manifest, publish it to the catalogue, and understand exactly what access a
workspace grants your app when it is installed.

Spec: `docs/yourcrm-agent-spec-pack/49-marketplace-sdk.md`. Migration
`0380`. Domain code lives in `packages/crm/src/marketplace/`; tables in
`packages/database/src/{schema,repositories}/marketplace*`; admin + catalogue
routes in `apps/api/src/routes/modules/marketplace.ts`; the workspace-facing
UI in `apps/web/app/app/marketplace/`.

This file lives in `@yourcrm/integrations` (not `@yourcrm/crm`) because it is
the same kind of document as that package's own `README.md` — a guide for
someone building an *extension*, not for someone building *core CRM
features*. It is documentation, not a published package: there is no
`@yourcrm/marketplace-sdk` npm module in P0.

## Relationship to `@yourcrm/integrations`

**Read `packages/integrations/src/provider.ts` and `registry.ts` before this
file — they are the model a marketplace app extends, not a separate one.**

An `IntegrationProvider` (that package) and a `MarketplaceApp` (this one)
share the same shape: a typed, self-describing unit, registered into a
catalogue, installed per workspace, uninstalled cleanly. Where they differ is
exactly where the underlying problem differs:

| | `IntegrationProvider` | `MarketplaceApp` |
| --- | --- | --- |
| What it is | Code, shipped with this deployment | Data — a submitted JSON manifest |
| Registered | In-process registry, at import time | Persisted row (`marketplace_apps`), via `registerApp()` |
| What it declares | `capabilities: IntegrationCapability[]` — a fixed vendor-adapter vocabulary (`email.send`, `calling.place`, …) | `scopes: "<object>:<action>"[]` — slices of the *existing* CRM permission model (`person:read`, `deal:update`, …) |
| Runs code | Yes — `connect()`/`disconnect()`/`healthCheck()` hooks execute in the API process | **No.** P0 has no plugin runtime. See "Not built in P0" below |
| Auth | A workspace-supplied secret (API key) | None yet — a scoped app token is a P1 extension point (see below) |
| Lifecycle | `integration_connections` install/uninstall per workspace | `app_installations` install/uninstall per workspace |

Both funnel every mutation through the same foundation pieces: `@yourcrm/permissions`'
`requirePermission()`, `@yourcrm/events`' envelope, and `AuditWriter` from
`packages/crm/src/ports.ts`. Neither module invents its own permission model,
event envelope, or audit sink — and your app manifest should not either.

## What a P0 app is

A P0 "app" is exactly three things, and nothing else:

1. A **manifest** — validated JSON, `appManifestSchema` in
   `packages/crm/src/marketplace/schemas.ts`.
2. A **scope grant set** — rows in `app_scope_grants`, computed once at
   install time and enforced on every check thereafter.
3. **Declared** (not dispatched) webhooks and **declared** (not mounted) UI
   extension points — metadata the consent screen shows a user before they
   install, and that a later phase can wire up without a manifest schema
   change.

There is no entry point, no bundle URL, no server your app hosts that YourCRM
calls into (yet). See "Not built in P0" at the bottom.

## The manifest

```ts
import { appManifestSchema } from "@yourcrm/crm/src/marketplace"

const manifest = appManifestSchema.parse({
  id: "acme-notes", // ^[a-z0-9][a-z0-9_-]{1,62}$ — stable, never reused for a different app
  name: "Acme Notes",
  version: "1.0.0", // semver
  publisher: "Acme Inc.",
  description: "Adds a notes panel to the person record.",
  scopes: ["person:read", "person:update"],
  webhooks: [{ event: "person.updated", description: "Sync notes when a contact changes." }],
  uiExtensionPoints: [{ location: "record.detail.tab", label: "Notes" }],
  docsUrl: "https://acme.example.com/docs/yourcrm-notes",
})
```

### `scopes`: the point of this module

Each entry is `"<object>:<action>"` — an object your app wants to touch
(`person`, `deal`, `company`, …) and one of `@yourcrm/permissions`'
`PERMISSION_ACTIONS` (`read`, `create`, `update`, `delete`, `export`, `share`,
`send_external`, `run_automation`, `run_ai`, `admin`). This is not a bespoke
capability list — it is literally the same vocabulary every domain service's
`requirePermission()` call already uses.

**An installed app never exceeds its granted scopes, and never exceeds the
permissions of the user who installed it — whichever is narrower wins.**
Concretely, at install time:

1. The service loads your manifest's requested scopes.
2. Each requested scope is checked against the **installing user's own live
   workspace role**, using the same foundation policy every other module
   uses (`packages/permissions/src/policy.ts`). A scope the installer
   couldn't exercise by hand is dropped, not silently upgraded.
3. Only the surviving scopes become `app_scope_grants` rows.
4. From then on, EVERY check against this installation
   (`assertAppScopeGranted` / `MarketplaceService.assertScope`) is a lookup
   against those rows — not the manifest, not the installer's role at
   install time (which may since have changed).

Uninstalling revokes every grant row for the installation. No grant survives
an uninstall; a reinstall recomputes grants from scratch.

This mirrors `packages/crm/src/automation/access.ts`, which solves the exact
same "the actor authoring a privileged unit is not necessarily the actor
whose permissions gate it at run time" problem for workflow automations.
Read that file if you are extending this one.

### `webhooks`: declared, not delivered (yet)

Each entry names a domain event (`<domain>.<entity>.<verb>`, matching the
`@yourcrm/events` envelope) your app wants to know about. **P0 stores this
declaration and does nothing else with it** — there is no outbound delivery
worker yet. A user installing your app sees which events you asked for as
part of the consent screen. Wiring actual delivery is a P1 extension point:
a BullMQ job (`apps/worker`) that fans out `EventBus` events to installations
whose manifest declared that event, POSTing an HMAC-signed payload the same
way `packages/integrations/src/provider.ts`'s `IntegrationWebhookSpec`
already signs *inbound* provider webhooks — just in the outbound direction.

### `uiExtensionPoints`: declared, not mounted (yet)

Each entry names a `location` (`record.detail.tab`, `record.detail.panel`,
`record.action`, `nav.item`, `dashboard.widget` — see
`APP_UI_EXTENSION_POINTS` in `schemas.ts`) and a human `label`. P0 shows
these on the install consent screen so a user knows where your app wants a
presence. **Nothing renders there in P0** — there is no extension host yet.
A later phase adding one should render only what a live `app_scope_grants`
row backs, the same enforcement point everything else in this doc uses.

## Publishing and installing

```
POST /api/v1/marketplace/apps            { manifest }              admin
GET  /api/v1/marketplace/apps                                       read
GET  /api/v1/marketplace/apps/:id                                   read
POST /api/v1/marketplace/apps/:id/install                           admin
GET  /api/v1/marketplace/installations                              read
GET  /api/v1/marketplace/installations/:id  (installation + grants)  read
DELETE /api/v1/marketplace/installations/:id  (uninstall)            admin
```

Browsing the catalogue and the installed-app list is a `read` action — any
workspace member can see what is available and what is installed. Publishing
a manifest and installing/uninstalling are `admin`-level: this deployment
has no separate developer-review workflow in P0 (full review/publishing and
a hosted marketplace are a later phase per the spec's own priorities), so
whoever can publish or install already has workspace-admin standing.

Every install/uninstall/publish is audited (`AuditWriter`, `packages/crm/src/ports.ts`)
and emits a domain event from `MarketplaceEvents` (`@yourcrm/events`):
`app.registered`, `app.installed`, `app.uninstalled`, `app.scope_denied` (when
an install drops a requested scope), `app.error`. Never emit a literal event
string — import the constant.

## How an app authenticates (P0)

**It does not — not yet.** P0 has no code execution, so there is no running
app process that would need to call back into YourCRM with a token. What P0
gives you is the enforcement primitive a future authenticated call would use:

```ts
import { createMarketplaceService } from "@yourcrm/crm/src/marketplace"

// Inside any future "act as this installed app" call site (a webhook
// receiver, a scoped API token middleware, …):
await marketplaceService.assertScope(ctx, installationId, "person", "update")
// Throws PermissionDeniedError (-> 403) unless a live app_scope_grants row
// says this installation may update a person. Nothing else gates this call.
```

When a later phase adds real app authentication (a scoped API token, a
signed JWT naming the installation), every domain-service call it makes must
go through `assertScope`/`assertAppScopeGranted`
(`packages/crm/src/marketplace/access.ts`) first — do not invent a second
permission system for it, the same rule `AGENTS.md` states for the rest of
this codebase.

## Not built in P0 — read before extending

There is **no plugin runtime**: no sandbox, no `eval`, no dynamic `import()`
of remote code, no iframe host, anywhere in this module. `install()` never
executes anything from your manifest — it validates it, computes a capped
grant set, and persists rows. Attempting to run third-party code in the API
process is out of scope for this phase and unsafe to add casually.

A future phase that adds actual app code (a `run()` hook, a hosted function,
a webhook delivery worker calling out to your service) needs, at minimum:

1. **Process isolation per invocation** — a sandboxed process or container,
   not the API process. An app must not share a heap, filesystem or outbound
   network path with the platform or with other installations.
2. **The same scope gate, reused** — every domain-service call app code
   makes routed through `assertAppScopeGranted`. Do not build a second
   authorization path "because the app already proved who it is."
3. **A hard wall-clock and memory budget per invocation**, enforced by the
   sandbox itself, not requested nicely by the app.
4. **No ambient credentials** — a scoped, short-lived token minted per
   invocation naming the installation and nothing else the app could
   exfiltrate and replay against a different workspace.

## Example manifest

```json
{
  "id": "acme-notes",
  "name": "Acme Notes",
  "version": "1.0.0",
  "publisher": "Acme Inc.",
  "description": "Adds a notes panel to the person record.",
  "scopes": ["person:read", "person:update"],
  "webhooks": [{ "event": "person.updated", "description": "Sync notes on contact change." }],
  "uiExtensionPoints": [{ "location": "record.detail.tab", "label": "Notes" }],
  "docsUrl": "https://acme.example.com/docs/yourcrm-notes"
}
```
