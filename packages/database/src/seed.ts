/**
 * Deterministic development seed. Creates a sample workspace, admin + sales
 * users, pipeline-stage placeholders live in domain packages later; here we
 * seed only foundation tables. Idempotent via fixed ids. Removable: run with
 * `SEED_RESET=1` to delete demo rows first.
 *
 * Usage: `bun run db:seed`
 */
import postgres from "postgres"

const DEMO_IDS = {
  workspace: "11111111-1111-4111-8111-111111111111",
  admin: "22222222-2222-4222-8222-222222222222",
  sales: "33333333-3333-4333-8333-333333333333",
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required to seed")
  const sql = postgres(url, { max: 1 })
  try {
    if (process.env.SEED_RESET === "1") {
      console.log("Removing demo seed data...")
      await sql`DELETE FROM memberships WHERE workspace_id = ${DEMO_IDS.workspace}::uuid`
      await sql`DELETE FROM users WHERE id IN (${DEMO_IDS.admin}::uuid, ${DEMO_IDS.sales}::uuid)`
      await sql`DELETE FROM workspaces WHERE id = ${DEMO_IDS.workspace}::uuid`
    }

    await sql`
      INSERT INTO workspaces (id, name, slug, timezone, currency)
      VALUES (${DEMO_IDS.workspace}::uuid, 'Demo Workspace', 'demo', 'UTC', 'USD')
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`
    await sql`
      INSERT INTO users (id, email, name)
      VALUES
        (${DEMO_IDS.admin}::uuid, 'admin@yourcrm.local', 'Demo Admin'),
        (${DEMO_IDS.sales}::uuid, 'sales@yourcrm.local', 'Demo Sales')
      ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`
    await sql`
      INSERT INTO memberships (workspace_id, user_id, role)
      VALUES
        (${DEMO_IDS.workspace}::uuid, ${DEMO_IDS.admin}::uuid, 'owner'),
        (${DEMO_IDS.workspace}::uuid, ${DEMO_IDS.sales}::uuid, 'member')
      ON CONFLICT (workspace_id, user_id) DO NOTHING`

    console.log("Seed complete: demo workspace + 2 users (marked demo data).")
    console.log("  workspace: Demo Workspace (demo)")
    console.log("  admin:     admin@yourcrm.local")
    console.log("  sales:     sales@yourcrm.local")
  } finally {
    await sql.end({ timeout: 5 })
  }
}

await main().catch((err) => {
  console.error("Seed failed:", err)
  process.exit(1)
})
