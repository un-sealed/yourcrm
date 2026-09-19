/**
 * Barrel generator for the two files every module agent touches:
 *
 * - `packages/crm/src/index.ts` (domain-service barrel)
 * - `packages/database/src/schema/index.ts` (table-definition barrel)
 *
 * Instead of hand-resolving eleven-way merge conflicts on these files, the
 * integrator runs this script after each merge. It scans each barrel's
 * directory for top-level sibling modules and rewrites only the relative
 * `export * from "./..."` lines (sorted, deduplicated), preserving every
 * other line (doc comments, constants, types) byte-for-byte.
 *
 * Conventions enforced:
 * - Only top-level `*.ts` siblings are barrelled (no recursion into
 *   subdirectories — those keep their own barrels).
 * - `index.ts`, `*.test.ts` and `*.d.ts` are never self-exported.
 * - One line per module, double quotes, no semicolons (repo Prettier style).
 *
 * Usage:
 *   bun run scripts/gen-barrels.ts          # regenerate both barrels
 *   bun run scripts/gen-barrels.ts --check  # CI: fail on drift
 *   (wired as `bun run gen:barrels` once the root package.json adds it —
 *   see scripts/README.md; editing package.json is outside this agent's scope)
 */
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")

const TARGETS = [
  { dir: join(ROOT, "packages", "crm", "src"), barrel: "index.ts" },
  { dir: join(ROOT, "packages", "database", "src", "schema"), barrel: "index.ts" },
]

const RELATIVE_EXPORT = /^export \* from "\.\/[^"]+";?$/

async function barrelModules(dir: string, barrel: string): Promise<string[]> {
  return (await readdir(dir))
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => f !== barrel && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
    .map((f) => f.slice(0, -".ts".length))
    .sort()
}

async function regenerate(dir: string, barrel: string): Promise<{ path: string; next: string }> {
  const path = join(dir, barrel)
  const current = await readFile(path, "utf8")
  const modules = await barrelModules(dir, barrel)
  const generated = modules.map((m) => `export * from "./${m}"`)

  const kept = current.split("\n").filter((line) => !RELATIVE_EXPORT.test(line.trim()))
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === "") kept.pop()
  const next = [...kept, ...generated, ""].join("\n")
  return { path, next }
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check")
  let stale = false
  for (const t of TARGETS) {
    const { path, next } = await regenerate(t.dir, t.barrel)
    if (check) {
      const current = await readFile(path, "utf8")
      if (current !== next) {
        console.error(`gen-barrels: ${path} is stale — run \`bun run scripts/gen-barrels.ts\``)
        stale = true
      }
    } else {
      await writeFile(path, next)
      console.log(`gen-barrels: regenerated ${path}`)
    }
  }
  if (check && stale) process.exit(1)
  if (check) console.log("gen-barrels: barrels up to date.")
}

await main()
