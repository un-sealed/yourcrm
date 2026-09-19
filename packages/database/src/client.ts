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
  const url = connectionString ?? process.env.DATABASE_URL
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
