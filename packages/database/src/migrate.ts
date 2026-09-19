/**
 * Transaction-safe migration runner. Applies every `migrations/*.sql` file
 * in filename order inside a single transaction per file, recording applied
 * filenames in `schema_migrations` so re-runs are no-ops.
 *
 * Usage: `bun run db:migrate` (root) or `bun run --filter @yourcrm/database db:migrate`.
 */
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import postgres from "postgres"

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations")

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required to run migrations")
  const sql = postgres(url, { max: 1 })

  try {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
    const applied = new Set(
      (await sql`SELECT filename FROM schema_migrations`.values()).map((r) => r[0] as string),
    )

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort()
    let ran = 0
    for (const file of files) {
      if (applied.has(file)) continue
      const content = await readFile(join(MIGRATIONS_DIR, file), "utf8")
      console.log(`Applying migration: ${file}`)
      await sql.begin(async (tx) => {
        // Split on statement boundaries is unnecessary: postgres.js executes
        // multi-statement strings via simple query protocol with .unsafe().
        await tx.unsafe(content)
        await tx`INSERT INTO schema_migrations (filename) VALUES (${file})`
      })
      ran++
    }
    console.log(ran === 0 ? "Migrations up to date." : `Applied ${ran} migration(s).`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

await main().catch((err) => {
  console.error("Migration failed:", err)
  process.exit(1)
})
