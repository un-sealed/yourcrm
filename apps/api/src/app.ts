import { Hono } from "hono"
import { cors } from "hono/cors"
import type { AppEnv } from "./hono-env"
import { getEnv } from "./env"
import { requestId } from "./middleware/request-id"
import { logger } from "./middleware/logger"
import { auth } from "./middleware/auth"
import { internalError, notFound } from "./middleware/errors"
import { healthRoutes, metricsMiddleware, metricsRoutes, readyRoutes } from "./routes/health"
import { v1Routes } from "./routes/v1"
import { openApiRoutes } from "./routes/openapi"

export function createApp() {
  const app = new Hono<AppEnv>()

  // Browser clients (web app, customer portal) call the API cross-origin.
  // Allowed origins come from env; localhost is always permitted in dev.
  const env = getEnv()
  const origins = Array.from(
    new Set([env.APP_URL, "http://localhost:3000", "http://127.0.0.1:3000"]),
  )
  app.use(
    "*",
    cors({
      origin: origins,
      allowHeaders: ["content-type", "authorization", "x-request-id"],
      exposeHeaders: ["x-request-id"],
    }),
  )

  app.use("*", requestId())
  app.use("*", logger())
  // Observability: counts request count/duration by route+status for /metrics.
  app.use("*", metricsMiddleware())
  app.use("*", auth())

  app.route("/health", healthRoutes())
  // Readiness (live dependency checks) and metrics (METRICS_ENABLED-gated).
  app.route("/ready", readyRoutes())
  app.route("/metrics", metricsRoutes())
  app.route("/api/v1", v1Routes())
  app.route("/", openApiRoutes())

  app.notFound((c) => notFound(c))
  app.onError((err, c) => internalError(c, err))

  return app
}

export type App = ReturnType<typeof createApp>
