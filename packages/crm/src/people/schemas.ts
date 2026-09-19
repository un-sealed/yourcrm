import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"

/**
 * People zod schemas. Services validate inputs with these; API routes reuse
 * them at the HTTP boundary via `@hono/zod-validator`.
 */

const nameSchema = z.string().trim().min(1).max(255)

export const personEmailInputSchema = z.object({
  email: z.string().trim().email().max(320),
  label: z.string().trim().max(64).nullish(),
  isPrimary: z.boolean().default(false),
})

export const personPhoneInputSchema = z.object({
  phone: z.string().trim().min(1).max(64),
  label: z.string().trim().max(64).nullish(),
  isPrimary: z.boolean().default(false),
})

export const createPersonSchema = z.object({
  firstName: nameSchema,
  lastName: nameSchema.nullish(),
  title: z.string().trim().max(255).nullish(),
  companyId: z.string().min(1).nullish(),
  ownerId: z.string().min(1).nullish(),
  status: z.enum(["active", "archived"]).nullish(),
  preferredChannel: z.enum(["email", "phone", "sms", "whatsapp"]).nullish(),
  notes: z.string().max(10000).nullish(),
  emails: z.array(personEmailInputSchema).max(10).default([]),
  phones: z.array(personPhoneInputSchema).max(10).default([]),
})

export type CreatePersonInput = z.infer<typeof createPersonSchema>

export const updatePersonSchema = createPersonSchema
  .omit({ emails: true, phones: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdatePersonInput = z.infer<typeof updatePersonSchema>

export const personQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  status: z.enum(["active", "archived"]).optional(),
})

export type PersonQuery = z.infer<typeof personQuerySchema>

export const personSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  firstName: z.string(),
  lastName: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  companyId: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  status: z.string(),
  preferredChannel: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type PersonDto = z.infer<typeof personSchema>
