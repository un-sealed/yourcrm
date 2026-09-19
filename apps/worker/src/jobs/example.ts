import { z } from "zod"

export const exampleJobSchema = z.object({
  message: z.string().min(1).max(500),
  correlationId: z.string().optional(),
})

export type ExampleJobInput = z.infer<typeof exampleJobSchema>

/**
 * Example/test job proving the infrastructure works end to end.
 * Jobs must be retryable, idempotent and observable (spec 01):
 * - input validated with zod at enqueue AND at run time
 * - handler is a pure function of (input) — safe to retry
 * - result + duration logged as JSON
 */
export async function runExampleJob(input: ExampleJobInput): Promise<{ echoed: string }> {
  const parsed = exampleJobSchema.parse(input)
  return { echoed: parsed.message }
}
