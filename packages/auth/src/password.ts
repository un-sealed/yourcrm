/**
 * Password hashing. Bun's built-in argon2id — no dependency allowed here.
 * Cost parameters are Bun's vetted defaults; do not hand-tune them.
 */

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" })
}

/** Verification returns false (never throws) for wrong/empty inputs. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!password || !hash) return false
  try {
    return await Bun.password.verify(password, hash)
  } catch {
    return false
  }
}
