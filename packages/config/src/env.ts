import { z } from "zod"

/**
 * Central environment schema. Every app validates at startup via
 * `loadEnv()` / `requireEnv()` and fails fast on missing secrets.
 *
 * Never silently fall back to production defaults in development.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  APP_URL: z.string().url().default("http://localhost:3000"),
  API_URL: z.string().url().default("http://localhost:4000"),
  WEB_PORT: z.coerce.number().int().positive().default(3000),
  API_PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .default("postgres://yourcrm:yourcrm_dev@localhost:5442/yourcrm"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

  STORAGE_ENDPOINT: z.string().min(1).default("http://localhost:9000"),
  STORAGE_REGION: z.string().min(1).default("us-east-1"),
  STORAGE_BUCKET: z.string().min(1).default("yourcrm"),
  STORAGE_ACCESS_KEY: z.string().min(1).default("minioadmin"),
  STORAGE_SECRET_KEY: z.string().min(1).default("minioadmin"),
  STORAGE_FORCE_PATH_STYLE: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === "true")
    .default(true),

  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 chars")
    .default("x".repeat(64)),
  ENCRYPTION_KEY: z
    .string()
    .min(32, "ENCRYPTION_KEY must be at least 32 chars")
    .default("y".repeat(64)),
  BETTER_AUTH_SECRET: z.string().min(16).optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),

  /**
   * AI provider (spec 34-ai-assistant). One OpenAI-compatible endpoint
   * covers OpenAI, OpenRouter, gateways and local Ollama/vLLM, so there is
   * one base URL and one key rather than a variable per vendor.
   *
   * `AI_USER_AGENT` is NOT cosmetic: some gateways authorise on the client
   * identity as well as the bearer token and answer `unauthorized client
   * detected` when it is missing or unrecognised. It is sent on every
   * request (see `createOpenAiCompatibleAiProvider`).
   *
   * `AI_API_KEY` and `AI_DEFAULT_MODEL` stay optional so the rest of the
   * app boots without an AI provider; the assistant endpoints answer 503
   * `AI_PROVIDER_NOT_CONFIGURED` until both are set. The key is never
   * logged, echoed in an error, or written to an audit row.
   */
  AI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  AI_API_KEY: z.string().optional(),
  AI_DEFAULT_MODEL: z.string().optional(),
  AI_USER_AGENT: z.string().min(1).default("yourcrm/0.1"),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(600_000).default(60_000),

  MCP_PORT: z.coerce.number().int().positive().default(4100),
  MCP_API_TOKEN: z.string().optional(),
})

export type Env = z.infer<typeof envSchema>

let cached: Env | null = null

/** Parse + validate `process.env` (Bun exposes `.env` via `Bun.env`). */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  if (cached) return cached
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n")
    throw new Error(`Invalid environment configuration:\n${details}`)
  }
  cached = parsed.data
  return cached
}

/** Validate at startup; throws on failure. Use in every app entrypoint. */
export function requireEnv(source?: Record<string, string | undefined>): Env {
  cached = null
  return loadEnv(source)
}

/** Test helper: reset the cached env between tests. */
export function __resetEnvCache(): void {
  cached = null
}
