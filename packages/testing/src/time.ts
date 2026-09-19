let globalCounter = 0

const perGeneratorCounters = new Map<string, number>()

function formatId(prefix: string, n: number): string {
  return `${prefix}_${String(n).padStart(4, "0")}`
}

/**
 * Process-wide deterministic id. Every call yields the next id for the
 * prefix (`ws_0001`, `user_0002`, …). Call `resetIdCounter()` in a
 * `beforeEach` when tests assert exact ids.
 */
export function nextId(prefix = "test"): string {
  globalCounter += 1
  return formatId(prefix, globalCounter)
}

/** Reset the `nextId` counter (typically in `beforeEach`). */
export function resetIdCounter(): void {
  globalCounter = 0
  perGeneratorCounters.clear()
}

export type IdGeneratorOptions = {
  /** Prefix for every generated id. Defaults to `"test"`. */
  prefix?: string
  /** First counter value. Defaults to `1`. Acts as the numeric seed. */
  start?: number
}

/**
 * Seeded id generator with local state: two generators with the same seed
 * produce the same sequence, independent of global test order.
 *
 * ```ts
 * const newId = createIdGenerator({ prefix: "person", start: 1 })
 * newId() // "person_0001"
 * newId() // "person_0002"
 * ```
 */
export function createIdGenerator(options: IdGeneratorOptions = {}): () => string {
  const prefix = options.prefix ?? "test"
  let n = options.start ?? 1
  return () => {
    const id = formatId(prefix, n)
    n += 1
    return id
  }
}

export type FrozenTime = {
  /** The frozen instant. */
  now: Date
  /** ISO string of the frozen instant. */
  iso: string
  /** Restore the real clock. Always call this (typically in `afterEach`). */
  restore: () => void
}

/**
 * Freeze the clock so snapshot-style assertions are stable. Patches
 * `Date.now()` and the no-arg `new Date()` constructor; explicit date
 * arguments pass through untouched.
 *
 * Kit factories (`makeBaseRecord`, stores) read the frozen clock, so build
 * fixtures after freezing.
 *
 * ```ts
 * let clock: FrozenTime
 * beforeEach(() => {
 *   clock = freezeTime("2026-01-01T00:00:00.000Z")
 * })
 * afterEach(() => {
 *   clock.restore()
 * })
 * ```
 */
export function freezeTime(iso = "2026-01-01T00:00:00.000Z"): FrozenTime {
  const RealDate = globalThis.Date
  const fixed = new RealDate(iso).getTime()
  if (Number.isNaN(fixed)) throw new Error(`freezeTime: invalid ISO date "${iso}"`)

  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixed)
      else super(...(args as ConstructorParameters<DateConstructor>))
    }

    static now(): number {
      return fixed
    }
  }

  globalThis.Date = FrozenDate as DateConstructor
  return {
    now: new RealDate(fixed),
    iso: new RealDate(fixed).toISOString(),
    restore: () => {
      globalThis.Date = RealDate
    },
  }
}
