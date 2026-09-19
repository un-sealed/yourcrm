import { loadEnv, type Env } from "@yourcrm/config"

let env: Env | null = null

/** Validated env singleton. `index.ts` calls this at startup (fail fast). */
export function getEnv(): Env {
  if (!env) env = loadEnv()
  return env
}
