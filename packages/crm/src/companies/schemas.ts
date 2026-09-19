import { z } from "zod"
import { paginationQuerySchema } from "@yourcrm/validation"

/**
 * Companies zod schemas. Services validate inputs with these; API routes reuse
 * them at the HTTP boundary via `@hono/zod-validator`.
 */

const nameSchema = z.string().trim().min(1).max(255)

export const companyAddressInputSchema = z.object({
  label: z.string().trim().max(64).nullish(),
  line1: z.string().trim().max(255).nullish(),
  city: z.string().trim().max(128).nullish(),
  region: z.string().trim().max(128).nullish(),
  postalCode: z.string().trim().max(32).nullish(),
  country: z.string().trim().max(128).nullish(),
  isPrimary: z.boolean().default(false),
})

export const createCompanySchema = z.object({
  name: nameSchema,
  domain: z.string().trim().max(255).nullish(),
  website: z.string().trim().max(1024).nullish(),
  industry: z.string().trim().max(128).nullish(),
  size: z.string().trim().max(64).nullish(),
  ownerId: z.string().min(1).nullish(),
  parentCompanyId: z.string().min(1).nullish(),
  status: z.enum(["active", "archived"]).nullish(),
  description: z.string().max(10000).nullish(),
  addresses: z.array(companyAddressInputSchema).max(10).default([]),
})

export type CreateCompanyInput = z.infer<typeof createCompanySchema>

export const updateCompanySchema = createCompanySchema
  .omit({ addresses: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "patch must not be empty" })

export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>

export const companyQuerySchema = paginationQuerySchema.extend({
  query: z.string().trim().max(255).optional(),
  status: z.enum(["active", "archived"]).optional(),
  industry: z.string().trim().max(128).optional(),
})

export type CompanyQuery = z.infer<typeof companyQuerySchema>

export const companySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  domain: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  size: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  parentCompanyId: z.string().nullable().optional(),
  status: z.string(),
  description: z.string().nullable().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
})

export type CompanyDto = z.infer<typeof companySchema>
