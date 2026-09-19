# ---- Base image: Bun ----
FROM oven/bun:1.4 AS base
WORKDIR /app

# ---- Dependencies ----
FROM base AS deps
COPY package.json turbo.json ./
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

# ---- API runtime ----
FROM base AS api
COPY --from=deps /app/node_modules ./node_modules
COPY . .
WORKDIR /app/apps/api
ENV API_PORT=4000
EXPOSE 4000
CMD ["bun", "run", "src/index.ts"]
