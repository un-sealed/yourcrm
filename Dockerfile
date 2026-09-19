# ---------------------------------------------------------------------------
# YourCRM — production images (Bun monorepo).
#
# One runnable image per app, all sharing cached dependency layers:
#
#   docker build --target api    -t yourcrm-api:latest .
#   docker build --target web    -t yourcrm-web:latest .
#   docker build --target worker -t yourcrm-worker:latest .
#   docker build --target mcp    -t yourcrm-mcp:latest .
#
# Self-hosters normally don't run these by hand — see
# `docker-compose.prod.yml` (`docker compose -f docker-compose.prod.yml up`).
#
# Rules honored here: no secrets baked in (config comes from the runtime
# environment), non-root runtime user, HEALTHCHECK on the HTTP apps.
# ---------------------------------------------------------------------------

# ---- Base image: Bun ----
FROM oven/bun:1.4 AS base
WORKDIR /app

# ---- Shared dependencies (cached once, reused by every app stage) ----
# Full install (incl. devDependencies): needed to build the web app.
FROM base AS deps
COPY package.json bun.lock turbo.json bunfig.toml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/mcp/package.json ./apps/mcp/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/validation/package.json ./packages/validation/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/auth/package.json ./packages/auth/package.json
COPY packages/permissions/package.json ./packages/permissions/package.json
COPY packages/events/package.json ./packages/events/package.json
COPY packages/storage/package.json ./packages/storage/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/notifications/package.json ./packages/notifications/package.json
COPY packages/search/package.json ./packages/search/package.json
COPY packages/crm/package.json ./packages/crm/package.json
COPY packages/ai/package.json ./packages/ai/package.json
COPY packages/agents/package.json ./packages/agents/package.json
COPY packages/workflows/package.json ./packages/workflows/package.json
COPY packages/integrations/package.json ./packages/integrations/package.json
RUN bun install

# Production-only install (runtime dependencies only): keeps the Bun
# service images (api/worker/mcp) free of build/test toolchains.
# Same manifest set as `deps` so the layer invalidates for the same reasons.
FROM base AS deps-prod
COPY package.json bun.lock turbo.json bunfig.toml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/mcp/package.json ./apps/mcp/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/validation/package.json ./packages/validation/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/auth/package.json ./packages/auth/package.json
COPY packages/permissions/package.json ./packages/permissions/package.json
COPY packages/events/package.json ./packages/events/package.json
COPY packages/storage/package.json ./packages/storage/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/notifications/package.json ./packages/notifications/package.json
COPY packages/search/package.json ./packages/search/package.json
COPY packages/crm/package.json ./packages/crm/package.json
COPY packages/ai/package.json ./packages/ai/package.json
COPY packages/agents/package.json ./packages/agents/package.json
COPY packages/workflows/package.json ./packages/workflows/package.json
COPY packages/integrations/package.json ./packages/integrations/package.json
RUN bun install --production

# ---- API runtime (Hono + Bun, serves /health) ----
FROM base AS api
COPY --from=deps-prod --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun . .
WORKDIR /app/apps/api
ENV NODE_ENV=production
ENV API_PORT=4000
EXPOSE 4000
USER bun
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r=await fetch('http://localhost:'+(process.env.API_PORT||'4000')+'/health').catch(()=>null);if(!r||!r.ok)process.exit(1)"
CMD ["bun", "run", "src/index.ts"]

# ---- Web runtime (Next.js, built inside the image as the non-root user) ----
FROM base AS web
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun . .
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
USER bun
# Build-time API_URL is only a fallback: next.config rewrites read API_URL
# again at `next start` time, so compose/prod values apply at runtime.
RUN bun --filter @yourcrm/web build
WORKDIR /app/apps/web
ENV WEB_PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "const r=await fetch('http://localhost:'+(process.env.WEB_PORT||'3000')+'/').catch(()=>null);if(!r||!r.ok)process.exit(1)"
CMD ["bun", "run", "start"]

# ---- Worker runtime (BullMQ + Bun) ----
FROM base AS worker
COPY --from=deps-prod --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun . .
WORKDIR /app/apps/worker
ENV NODE_ENV=production
USER bun
CMD ["bun", "run", "src/index.ts"]

# ---- MCP runtime (stdio transport; keep stdin open via compose) ----
FROM base AS mcp
COPY --from=deps-prod --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun . .
WORKDIR /app/apps/mcp
ENV NODE_ENV=production
ENV MCP_PORT=4100
EXPOSE 4100
USER bun
CMD ["bun", "run", "src/index.ts"]
