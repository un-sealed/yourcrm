import { z } from "zod"

/**
 * Auth request contracts (Wave-1: email+password only — no OAuth/SAML/OIDC/
 * magic links; those are later phases). The platform-seams agent mounts
 * these schemas on `POST /api/v1/auth/signup|login`; the web app posts the
 * same shapes. Changing a schema here is a versioned-API change.
 */

export const MIN_PASSWORD_LENGTH = 8

export const emailSchema = z.string().trim().toLowerCase().email().max(320)

export const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(256)

export const signupSchema = z.object({
  name: z.string().trim().min(1).max(255),
  email: emailSchema,
  password: passwordSchema,
  /** Defaults to "<name>'s workspace" slugified when omitted. */
  workspaceName: z.string().trim().min(1).max(255).optional(),
})

export type SignupInput = z.infer<typeof signupSchema>

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
})

export type LoginInput = z.infer<typeof loginSchema>
