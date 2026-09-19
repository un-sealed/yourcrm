import { moduleRoutes } from "../routes/modules/index"

/**
 * Assemble `/openapi.json` from the registered module routers. Each module
 * contributes its own `openApiPaths`; this file only adds the document shell
 * (info, servers, non-versioned paths) so module agents never edit shared
 * OpenAPI code — they export `openApiPaths` from their module file.
 */
export function buildOpenApiDocument() {
  const paths: Record<string, unknown> = {
    "/health": { get: { summary: "Liveness + dependency status", operationId: "health" } },
  }
  for (const mod of moduleRoutes) {
    for (const [path, methods] of Object.entries(mod.openApiPaths ?? {})) {
      paths[path] = methods
    }
  }
  return {
    openapi: "3.1.0",
    info: { title: "YourCRM API", version: "0.1.0" },
    servers: [{ url: "/api/v1" }],
    paths,
  }
}
