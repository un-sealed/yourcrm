import { z } from "zod"

const clientEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
})

export type ClientEnv = z.infer<typeof clientEnvSchema>

/** Validated browser-safe env (NEXT_PUBLIC_* only — never secrets). */
export function getClientEnv(): ClientEnv {
  return clientEnvSchema.parse({
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  })
}
