# `@yourcrm/integrations`

The connector framework's **provider SDK**: the typed `IntegrationProvider`
contract every third-party adapter implements, and the registry providers
register themselves into. Nothing here — or anywhere else in the framework —
hardcodes a vendor list.

Spec: `docs/yourcrm-agent-spec-pack/31-integrations.md`. Migration `0180`.

## Where the framework lives

The runtime around this contract is split by what each layer can reach in the
workspace dependency graph:

| Concern                                                                              | Location                                                    |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Provider contract, registry, capabilities                                            | `packages/integrations/src/`                                |
| Connection lifecycle, permissions, events, audit, webhook verification + idempotency | `packages/crm/src/integrations/`                            |
| Tables, AES-256-GCM credential encryption at rest                                    | `packages/database/src/{schema,repositories}/integrations*` |
| Admin routes + public webhook endpoint                                               | `apps/api/src/routes/modules/integrations.ts`               |
| Catalogue UI                                                                         | `apps/web/app/app/integrations/`                            |

> **Blocker (integrator).** Neither `@yourcrm/crm` nor `apps/api` declares
> `@yourcrm/integrations`, so bun does not symlink it into their
> `node_modules` and the import does not resolve (verified: TS2307). Until the
> dependency is declared, `packages/crm/src/integrations/types.ts` carries a
> structural mirror of the contract (`IntegrationProviderPort`) and the API
> route ships an explicit provider list. Wiring the dependency makes both
> one-line changes — each site says exactly what to replace.

## Writing a provider

```ts
import { z } from "zod"
import { defineIntegrationProvider, registerIntegrationProvider } from "@yourcrm/integrations"

export const resendProvider = defineIntegrationProvider({
  id: "resend",
  displayName: "Resend",
  category: "email",
  capabilities: ["email.send"],
  authKind: "api_key",
  configSchema: z.object({ fromAddress: z.string().email() }),
  secretLabel: "API key",
  webhook: {
    signatureHeader: "svix-signature",
    algorithm: "sha256",
    encoding: "base64",
    extractEventId: (payload) => readId(payload),
    handle: async (delivery) => ({ status: "processed", eventType: delivery.eventType }),
  },
  connect: async ({ secret }) => ({ externalAccountId: await whoami(secret) }),
  disconnect: async () => undefined,
  healthCheck: async ({ secret }) =>
    (await ping(secret)) ? { status: "connected" } : { status: "error", message: "unreachable" },
})

registerIntegrationProvider(resendProvider)
```

Rules for adapter authors:

- **Never touch credentials directly.** The framework decrypts and hands you
  `secret` for the duration of a hook call. Do not persist, log or echo it.
- **Never verify signatures yourself.** Declare `webhook.signatureHeader` /
  `algorithm` / `signaturePrefix`; the framework verifies in constant time
  against the connection's stored secret before `handle()` is called.
- **`handle()` may be called more than once** for a delivery that previously
  failed. Be idempotent.
- **No module-scope side effects** beyond registration: hooks must not do
  network or database work until they are called.

## Credential storage

Secrets are sealed with AES-256-GCM (key derived from `ENCRYPTION_KEY` via
HKDF-SHA256) in `packages/database/src/repositories/integrations-repository.ts`
before they reach SQL. `integration_credentials` has no plaintext column. The
only path back to plaintext is `readCredentialSecret()`, used by the domain
service to feed a provider hook. Every API response carries a masked hint
(`sk-…4f2a`) and nothing more.

## Not in P0

OAuth. `authKind: "oauth2"` and the `oauth_tokens` credential kind exist so the
contract and storage are shaped for it, and the domain service rejects OAuth
connects with `NOT_IMPLEMENTED`. The step-by-step extension point is documented
at the bottom of `src/provider.ts`.
