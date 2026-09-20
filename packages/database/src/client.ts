import { loadEnv } from "@yourcrm/config"
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema"

export type Database = PostgresJsDatabase<typeof schema>

let db: Database | null = null
let sqlClient: ReturnType<typeof postgres> | null = null

/**
 * Shared database client. This is the ONLY place a postgres connection is
 * created — apps and domain services import `getDb()`, never `postgres()`.
 */
export function getDb(connectionString?: string): Database {
  if (db) return db
  // Resolve through @yourcrm/config, not raw process.env. The config schema
  // validates DATABASE_URL and supplies the local default, so reading
  // process.env directly gave two sources of truth: getEnv() would succeed
  // while getDb() threw, producing a 500 at request time instead of a clear
  // failure at boot. That surfaced as "invalid email or password" on login.
  const url = connectionString ?? loadEnv().DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required (see .env.example)")
  sqlClient = postgres(url, { max: 10, prepare: false })
  db = drizzle(sqlClient, { schema })
  return db
}

/** Close the pool (tests / worker shutdown). */
export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 })
    sqlClient = null
    db = null
  }
}

export { schema }
