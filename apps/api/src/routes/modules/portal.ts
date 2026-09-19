import { zValidator } from "@hono/zod-validator"
import {
  createLoginRateLimiters,
  generateSessionToken,
  hashSessionToken,
  type LoginRateLimiters,
} from "@yourcrm/auth"
import {
  createPortalService,
  portalInvoiceQuerySchema,
  portalInvoiceSchema,
  portalMagicLinkRequestSchema,
  portalQuoteQuerySchema,
  portalQuoteSchema,
  portalSessionExchangeSchema,
  portalTicketQuerySchema,
  portalTicketSchema,
  PortalNotFoundError,
  PortalUnauthorizedError,
  type PortalContext,
  type PortalService,
} from "@yourcrm/crm/src/portal"
import { getDb, writeAudit } from "@yourcrm/database"
import { createPortalRepository } from "@yourcrm/database/src/repositories/portal-repository"
import { errorEnvelope, paginatedEnvelopeSchema } from "@yourcrm/validation"
import { Hono } from "hono"
import type { Context } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { z } from "zod"
import type { AppEnv } from "../../hono-env"
import { getEnv } from "../../env"
import { zodToJsonSchema } from "../../openapi/zod-to-json-schema"

/**
 * Customer portal HTTP layer (spec 45-customer-portal, P0).
 *
 * THIS ROUTER SERVES PEOPLE WHO ARE NOT WORKSPACE MEMBERS.
 * --------------------------------------------------------
 * Read that sentence again before adding an endpoint here. Consequences that
 * are load-bearing, not stylistic:
 *
 *  - `requireSession()` NEVER appears in this file. That middleware resolves
 *    the member session and every other module's handler assumes it ran.
 *    A portal caller has no member session and must never acquire one.
 *  - The portal cookie has its own name (`yourcrm_portal_session`) and its
 *    own token space (`portal_sessions`). A member cookie presented here
 *    resolves to nothing, and a portal cookie presented to `/api/v1/people`
 *    resolves to nothing, because each resolver only reads its own table.
 *  - Nothing in this file constructs a `Session` or a `ServiceContext`, and
 *    the portal service could not accept one if it did.
 *  - 403 IS NOT IN THE VOCABULARY. Out-of-scope records are 404, identically
 *    to records that do not exist. Missing/expired credentials are 401.
 *
 * MOUNTING: this file is not in the generated `routes/modules/index.ts` yet —
 * regenerating it is the integrator's step (`bun run gen:routes`), not a
 * module agent's. Until then these routes exist and are fully tested but are
 * not mounted on the running app.
 */

export const basePath = "/portal"

/** Distinct from `yourcrm_session` on purpose. See the header. */
export const PORTAL_SESSION_COOKIE_NAME = "yourcrm_portal_session"

const portalIdentityEnvelopeSchema = z.object({
  data: z.object({
    identityId: z.string(),
    email: z.string(),
    displayName: z.string().nullable(),
    entitlements: z.object({ tickets: z.boolean(), invoices: z.boolean(), quotes: z.boolean() }),
  }),
})

const portalInvoiceEnvelope = z.object({ data: portalInvoiceSchema })
const portalInvoiceListEnvelope = paginatedEnvelopeSchema(portalInvoiceSchema)
const portalQuoteEnvelope = z.object({ data: portalQuoteSchema })
const portalQuoteListEnvelope = paginatedEnvelopeSchema(portalQuoteSchema)
const portalTicketEnvelope = z.object({ data: portalTicketSchema })
const portalTicketListEnvelope = paginatedEnvelopeSchema(portalTicketSchema)

export type PortalRouteDeps = {
  service?: PortalService
  limiters?: LoginRateLimiters
  /** Where the emailed link points. Defaults to `APP_URL` + `/portal/verify`. */
  portalBaseUrl?: string
  /** Cookies are `Secure` unless a test says otherwise. */
  secureCookies?: boolean
}

/**
 * Dev delivery fallback.
 *
 * Mirrors `console-email-provider.ts`: a self-hoster with nothing but
 * Postgres running must be able to complete a login. Outside development the
 * fallback refuses to print the link — it logs that no deliverer is wired and
 * the customer simply never receives one, which is the safe failure.
 */
function consoleMagicLinkDelivery(portalBaseUrl: string) {
  return async (message: { email: string; token: string; expiresAt: Date }): Promise<void> => {
    if ((process.env.NODE_ENV ?? "development") === "production") {
      console.warn(
        `[portal] magic link issued for a customer but no delivery transport is configured; the link was not sent`,
      )
      return
    }
    const url = `${portalBaseUrl}?token=${encodeURIComponent(message.token)}`
    console.log(`[portal] magic link for ${message.email} (dev only): ${url}`)
  }
}

function defaultService(portalBaseUrl: string): PortalService {
  const db = getDb()
  const repository = createPortalRepository()
  return createPortalService({
    identities: {
      findActiveByEmail: async (email) => repository.findActiveIdentitiesByEmail(db, email),
      findActiveById: async (workspaceId, id) =>
        repository.findActiveIdentityById(db, workspaceId, id),
      listActiveGrants: async (workspaceId, identityId) => {
        const rows = await repository.listActiveGrants(db, workspaceId, identityId)
        return rows.map((row) => ({
          scopeType: row.scopeType === "company" ? "company" : "person",
          scopeId: row.scopeId,
          canViewTickets: row.canViewTickets,
          canViewInvoices: row.canViewInvoices,
          canViewQuotes: row.canViewQuotes,
        }))
      },
      markLogin: async (workspaceId, identityId) => {
        await repository.markIdentityLogin(db, workspaceId, identityId)
      },
    },
    sessions: {
      createMagicLink: (input) => repository.createMagicLink(db, input),
      consumeMagicLink: (tokenHash) => repository.consumeMagicLink(db, tokenHash),
      createSession: (input) => repository.createSession(db, input),
      findActiveSession: (tokenHash) => repository.findActiveSession(db, tokenHash),
      touchSession: async (sessionId) => {
        await repository.touchSession(db, sessionId)
      },
      revokeSession: async (workspaceId, sessionId) => {
        await repository.revokeSession(db, workspaceId, sessionId)
      },
    },
    // The portal does not invent crypto: these are the same CSPRNG and the
    // same SHA-256 the member session layer uses (`@yourcrm/auth/tokens`).
    tokens: { generate: generateSessionToken, hash: hashSessionToken },
    billing: {
      listInvoices: (scope, query) => repository.listInvoices(db, scope, query),
      findInvoice: async (scope, invoiceId) => {
        const invoice = await repository.findInvoice(db, scope, invoiceId)
        if (!invoice) return null
        const [lineItems, amountPaidCents] = await Promise.all([
          repository.listInvoiceLineItems(db, scope, invoiceId),
          repository.sumInvoicePayments(db, scope, invoiceId),
        ])
        return { invoice, lineItems, amountPaidCents }
      },
      listQuotes: (scope, query) => repository.listQuotes(db, scope, query),
      findQuote: async (scope, quoteId) => {
        const quote = await repository.findQuote(db, scope, quoteId)
        if (!quote) return null
        return { quote, lineItems: await repository.listQuoteLineItems(db, scope, quoteId) }
      },
    },
    // INTEGRATOR: bind `tickets` to the support module's scoped reader here.
    // Its implementation must apply `scope` in SQL exactly the way
    // `portalScopeCondition` does. Left unbound, tickets read as empty.
    tickets: undefined,
    deliverMagicLink: consoleMagicLinkDelivery(portalBaseUrl),
    audit: async (input) => {
      await writeAudit(db, { ...input, source: input.source ?? "integration" })
    },
  })
}

function requestId(c: Context<AppEnv>): string | undefined {
  return c.get("requestId") as string | undefined
}

function callerIp(c: Context<AppEnv>): string {
  const forwarded = c.req.header("x-forwarded-for")
  const first = forwarded?.split(",")[0]?.trim()
  return first && first !== "" ? first : "unknown"
}

/** Cookie first, then `Authorization: Bearer` for non-browser clients. */
function portalTokenOf(c: Context<AppEnv>): string | null {
  const cookie = getCookie(c, PORTAL_SESSION_COOKIE_NAME)
  if (cookie) return cookie
  const header = c.req.header("authorization")
  if (header?.toLowerCase().startsWith("bearer ")) {
    const token = header.slice("bearer ".length).trim()
    return token || null
  }
  return null
}

function mapError(c: Context<AppEnv>, err: unknown) {
  if (err instanceof PortalUnauthorizedError) {
    return c.json(errorEnvelope("UNAUTHORIZED", err.message, requestId(c)), 401)
  }
  if (err instanceof PortalNotFoundError) {
    return c.json(errorEnvelope("NOT_FOUND", err.message, requestId(c)), 404)
  }
  if (err instanceof z.ZodError) {
    return c.json(
      errorEnvelope("VALIDATION_ERROR", "Invalid request", requestId(c), err.flatten()),
      400,
    )
  }
  throw err
}

/**
 * Shared 400 handler for `zValidator`. Typed against the base Hono `Context`
 * (that is what the hook receives), so the request id comes off the header
 * rather than the typed context variable.
 */
function validationHook(message: string) {
  return (result: { success: boolean; error?: z.ZodError }, c: Context) => {
    if (!result.success) {
      return c.json(
        errorEnvelope(
          "VALIDATION_ERROR",
          message,
          c.req.header("x-request-id") ?? undefined,
          result.error?.flatten(),
        ),
        400,
      )
    }
  }
}

export function createRoutes(deps: PortalRouteDeps = {}) {
  const app = new Hono<AppEnv>()
  const limiters = deps.limiters ?? createLoginRateLimiters()
  // Lazy default wiring: route construction must never touch the database —
  // registry and full-app tests mount every module without a live Postgres.
  let cached: PortalService | null = deps.service ?? null
  const service = () =>
    (cached ??= defaultService(deps.portalBaseUrl ?? `${getEnv().APP_URL}/portal/verify`))

  /**
   * Resolve the portal session or throw 401. Note what is NOT here: no
   * `c.get("session")`, no role, no workspace header. The cookie is the only
   * input and `portal_sessions` is the only table consulted.
   */
  async function portalContextOf(c: Context<AppEnv>): Promise<PortalContext> {
    const token = portalTokenOf(c)
    if (!token) throw new PortalUnauthorizedError()
    const ctx = await service().resolveSession(token, requestId(c))
    if (!ctx) throw new PortalUnauthorizedError()
    return ctx
  }

  /* -------------------------------- auth -------------------------------- */

  /**
   * Request a magic link.
   *
   * Always 202, always the same body: known address, unknown address,
   * revoked identity and expired access are indistinguishable from out here.
   * Rate limiting is keyed on the SUBMITTED address (whether or not it
   * exists) and on the caller IP, so a 429 says nothing about existence
   * either.
   */
  app.post(
    "/auth/magic-link",
    zValidator("json", portalMagicLinkRequestSchema, validationHook("Invalid request body")),
    async (c) => {
      const { email } = c.req.valid("json")
      const ip = callerIp(c)
      if (
        !limiters.perIp.isAllowed(`portal:ip:${ip}`) ||
        !limiters.perAccount.isAllowed(`portal:email:${email}`)
      ) {
        return c.json(
          errorEnvelope("RATE_LIMITED", "Too many requests. Please try again later.", requestId(c)),
          429,
        )
      }
      try {
        await service().requestMagicLink(
          { email },
          {
            userAgent: c.req.header("user-agent")?.slice(0, 255) ?? null,
            correlationId: requestId(c) ?? null,
          },
        )
      } catch (err) {
        return mapError(c, err)
      }
      return c.json({ data: { requested: true } }, 202)
    },
  )

  /** Exchange a link for a session cookie. Single use is enforced in SQL. */
  app.post(
    "/auth/session",
    zValidator("json", portalSessionExchangeSchema, validationHook("Invalid request body")),
    async (c) => {
      try {
        const granted = await service().exchangeMagicLink(c.req.valid("json"), {
          userAgent: c.req.header("user-agent")?.slice(0, 255) ?? null,
          correlationId: requestId(c) ?? null,
        })
        setCookie(c, PORTAL_SESSION_COOKIE_NAME, granted.token, {
          path: "/",
          httpOnly: true,
          sameSite: "Lax",
          secure: deps.secureCookies ?? true,
          maxAge: Math.max(1, Math.floor((granted.expiresAt.getTime() - Date.now()) / 1000)),
        })
        return c.json({
          data: { identity: granted.identity, expiresAt: granted.expiresAt.toISOString() },
        })
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.post("/auth/logout", async (c) => {
    try {
      const ctx = await portalContextOf(c)
      await service().logout(ctx)
    } catch (err) {
      // A logout with no (or a dead) session is a no-op, not an error: the
      // customer's intent — "end my session" — is already satisfied.
      if (!(err instanceof PortalUnauthorizedError)) return mapError(c, err)
    }
    deleteCookie(c, PORTAL_SESSION_COOKIE_NAME, { path: "/" })
    return c.json({ data: { loggedOut: true } })
  })

  app.get("/me", async (c) => {
    try {
      return c.json({ data: service().me(await portalContextOf(c)) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  /* -------------------------------- reads ------------------------------- */

  app.get(
    "/tickets",
    zValidator("query", portalTicketQuerySchema, validationHook("Invalid query parameters")),
    async (c) => {
      try {
        return c.json(await service().listTickets(await portalContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/tickets/:id", async (c) => {
    try {
      const ctx = await portalContextOf(c)
      return c.json({ data: await service().getTicket(ctx, c.req.param("id")) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.get(
    "/invoices",
    zValidator("query", portalInvoiceQuerySchema, validationHook("Invalid query parameters")),
    async (c) => {
      try {
        return c.json(await service().listInvoices(await portalContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/invoices/:id", async (c) => {
    try {
      const ctx = await portalContextOf(c)
      return c.json({ data: await service().getInvoice(ctx, c.req.param("id")) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  app.get(
    "/quotes",
    zValidator("query", portalQuoteQuerySchema, validationHook("Invalid query parameters")),
    async (c) => {
      try {
        return c.json(await service().listQuotes(await portalContextOf(c), c.req.valid("query")))
      } catch (err) {
        return mapError(c, err)
      }
    },
  )

  app.get("/quotes/:id", async (c) => {
    try {
      const ctx = await portalContextOf(c)
      return c.json({ data: await service().getQuote(ctx, c.req.param("id")) })
    } catch (err) {
      return mapError(c, err)
    }
  })

  return app
}

export const openApiPaths = {
  "/api/v1/portal/auth/magic-link": {
    post: {
      summary:
        "Request a customer portal magic link. Always 202 — the response is identical for known and unknown addresses.",
      operationId: "requestPortalMagicLink",
      requestBody: {
        content: {
          "application/json": { schema: zodToJsonSchema(portalMagicLinkRequestSchema) },
        },
      },
    },
  },
  "/api/v1/portal/auth/session": {
    post: {
      summary: "Exchange a single-use magic link for a portal session cookie",
      operationId: "createPortalSession",
      requestBody: {
        content: { "application/json": { schema: zodToJsonSchema(portalSessionExchangeSchema) } },
      },
    },
  },
  "/api/v1/portal/auth/logout": {
    post: { summary: "Revoke the current portal session", operationId: "logoutPortalSession" },
  },
  "/api/v1/portal/me": {
    get: {
      summary: "The signed-in portal identity and its entitlements",
      operationId: "getPortalMe",
    },
  },
  "/api/v1/portal/tickets": {
    get: { summary: "The customer's own tickets", operationId: "listPortalTickets" },
  },
  "/api/v1/portal/tickets/{id}": {
    get: {
      summary: "One of the customer's own tickets, public comments only (404 otherwise)",
      operationId: "getPortalTicket",
    },
  },
  "/api/v1/portal/invoices": {
    get: { summary: "The customer's own invoices", operationId: "listPortalInvoices" },
  },
  "/api/v1/portal/invoices/{id}": {
    get: {
      summary: "One of the customer's own invoices (404 otherwise, never 403)",
      operationId: "getPortalInvoice",
    },
  },
  "/api/v1/portal/quotes": {
    get: { summary: "The customer's own quotes", operationId: "listPortalQuotes" },
  },
  "/api/v1/portal/quotes/{id}": {
    get: {
      summary: "One of the customer's own quotes (404 otherwise, never 403)",
      operationId: "getPortalQuote",
    },
  },
}

export {
  portalIdentityEnvelopeSchema,
  portalInvoiceEnvelope,
  portalInvoiceListEnvelope,
  portalQuoteEnvelope,
  portalQuoteListEnvelope,
  portalTicketEnvelope,
  portalTicketListEnvelope,
}
