import { and, eq, isNull } from "drizzle-orm"
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import type { Database } from "../client"
import { baseColumns } from "./base"
import { memberships, users, workspaces } from "./core"

/**
 * Wave-1 auth persistence (spec 04-authentication, email+password only).
 *
 * NOTE (wave-1 integration): this file is not yet re-exported from
 * `schema/index.ts` (owned by the shared-tables agent this wave). Until the
 * integrator wires the barrel, server code imports it via the subpath
 * `@yourcrm/database/src/schema/auth`.
 *
 * Layering: this is the ONLY place auth SQL lives. `@yourcrm/auth` defines
 * the service logic against structurally-compatible record shapes and never
 * imports this module (base packages must not import infra); `apps/api`
 * adapts these functions to the `AuthStore` port.
 */

/** Argon2id password hash per user. Separate table: `users` is untouched. */
export const credentials = pgTable("credentials", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export type Credential = typeof credentials.$inferSelect
export type NewCredential = typeof credentials.$inferInsert

/**
 * Server-side session. `tokenHash` is SHA-256(raw token); the raw token is
 * never stored. Expiry/revocation are enforced here, not by the cookie.
 */
export const sessions = pgTable("sessions", {
  ...baseColumns,
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  userAgent: text("user_agent"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
})

export type AuthSessionRow = typeof sessions.$inferSelect
export type NewAuthSessionRow = typeof sessions.$inferInsert

/** Query executor shared by pool clients and interactive transactions. */
export type AuthDb = Database | Parameters<Parameters<Database["transaction"]>[0]>[0]

export type SignupRows = {
  userId: string
  workspaceId: string
}

/** Find an active (non-deleted) user by lower-cased email. */
export async function findUserByEmail(db: AuthDb, email: string) {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)))
    .limit(1)
  return rows[0] ?? null
}

/** Find an active user by id. */
export async function findUserById(db: AuthDb, id: string) {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .limit(1)
  return rows[0] ?? null
}

/** All memberships for a user (drives the `Session.memberships` shape). */
export async function listMembershipsForUser(db: AuthDb, userId: string) {
  return db
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, userId), isNull(memberships.deletedAt)))
}

/** Workspace slug lookup (signup collision handling). */
export async function findWorkspaceBySlug(db: AuthDb, slug: string) {
  const rows = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.slug, slug), isNull(workspaces.deletedAt)))
    .limit(1)
  return rows[0] ?? null
}

export async function getCredential(db: AuthDb, userId: string) {
  const rows = await db.select().from(credentials).where(eq(credentials.userId, userId)).limit(1)
  return rows[0] ?? null
}

export async function upsertCredential(db: AuthDb, userId: string, passwordHash: string) {
  await db
    .insert(credentials)
    .values({ userId, passwordHash })
    .onConflictDoUpdate({
      target: credentials.userId,
      set: { passwordHash, updatedAt: new Date() },
    })
}

/**
 * Signup in one transaction: user + workspace + owner membership +
 * credential. Callers hash the password first (Bun.password, argon2id).
 */
export async function createUserWithWorkspace(
  db: Database,
  input: {
    email: string
    name: string
    passwordHash: string
    workspaceName: string
    workspaceSlug: string
  },
): Promise<SignupRows> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email: input.email, name: input.name })
      .returning({ id: users.id })
    if (!user) throw new Error("auth.signup: user insert returned no row")
    const [workspace] = await tx
      .insert(workspaces)
      .values({ name: input.workspaceName, slug: input.workspaceSlug })
      .returning({ id: workspaces.id })
    if (!workspace) throw new Error("auth.signup: workspace insert returned no row")
    await tx.insert(memberships).values({
      workspaceId: workspace.id,
      userId: user.id,
      role: "owner",
    })
    await tx.insert(credentials).values({ userId: user.id, passwordHash: input.passwordHash })
    return { userId: user.id, workspaceId: workspace.id }
  })
}

export async function touchLastLogin(db: AuthDb, userId: string) {
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId))
}

export async function insertSession(
  db: AuthDb,
  row: {
    userId: string
    workspaceId: string
    tokenHash: string
    expiresAt: Date
    userAgent: string | null
  },
) {
  const [session] = await db.insert(sessions).values(row).returning()
  if (!session) throw new Error("auth.session: insert returned no row")
  return session
}

/** Token lookup by hash; expiry/revocation enforced by the caller. */
export async function findSessionByTokenHash(db: AuthDb, tokenHash: string) {
  const rows = await db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).limit(1)
  return rows[0] ?? null
}

export async function touchSession(db: AuthDb, id: string) {
  await db
    .update(sessions)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(sessions.id, id))
}

/** Server-side revocation (logout). Idempotent: unknown hashes are a no-op. */
export async function revokeSessionByTokenHash(db: AuthDb, tokenHash: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(sessions.tokenHash, tokenHash))
}

export async function revokeUserSessions(db: AuthDb, userId: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
}
