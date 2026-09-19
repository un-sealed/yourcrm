#!/usr/bin/env bun
/**
 * Render a paste-ready module-agent prompt from the template + registry.
 *
 *   bun run docs/agent-prompts/render.ts --list
 *   bun run docs/agent-prompts/render.ts --slugs
 *   bun run docs/agent-prompts/render.ts companies
 *   bun run docs/agent-prompts/render.ts --all --out /tmp/prompts
 *   bun run docs/agent-prompts/render.ts --worktrees     # setup commands
 */

import { WAVE_2, type ModuleSpec } from "./modules"

const TEMPLATE_PATH = new URL("./MODULE-AGENT-TEMPLATE.md", import.meta.url).pathname

function render(mod: ModuleSpec, template: string): string {
  const softRefNote = mod.softRefs.length
    ? `\nCross-module references (plain uuid columns, **no foreign key**): ` +
      mod.softRefs.map((r) => `\`${r}\``).join(", ")
    : ""

  const vars: Record<string, string> = {
    MODULE_TITLE: mod.title,
    MODULE_SLUG: mod.slug,
    SPEC_FILE: mod.specFile,
    MIGRATION_SLOT: mod.migrationSlot,
    ROUTE_PREFIX: `/api/v1/${mod.slug}`,
    NAV_HREF: `/app/${mod.slug}`,
    PERMISSION_OBJECT: mod.permissionObject,
    BRANCH: `agent/${mod.slug}`,
    TABLES: mod.tables.map((t) => `\`${t}\``).join(", "),
    EVENT_NAMES: mod.events.length ? mod.events.map((e) => `\`${e}\``).join(", ") : "none",
    P0_EXTRA: mod.p0Extra.join("\n") + softRefNote,
  }

  let out = template
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, value)
  }

  const leftover = out.match(/\{\{[A-Z_]+\}\}/g)
  if (leftover) throw new Error(`unresolved placeholders: ${[...new Set(leftover)].join(", ")}`)
  return out
}

function table(): string {
  const rows = WAVE_2.map(
    (m) =>
      `| ${m.title} | \`agent/${m.slug}\` | ${m.migrationSlot} | /api/v1/${m.slug} | ${m.tables.join(", ")} |`,
  )
  return [
    "| Module | Branch | Slot | Route prefix | Tables |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n")
}

function worktrees(): string {
  return [
    "# run once, from the repo root",
    "git init && git add -A && git commit -m 'chore: foundation + wave-1'",
    "",
    ...WAVE_2.flatMap((m) => [
      `git worktree add ../yourcrm-${m.slug} -b agent/${m.slug}`,
      `(cd ../yourcrm-${m.slug} && bun install --frozen-lockfile)`,
    ]),
  ].join("\n")
}

const args = Bun.argv.slice(2)
const template = await Bun.file(TEMPLATE_PATH).text()

if (args.includes("--slugs")) {
  console.log(WAVE_2.map((m) => m.slug).join("\n"))
} else if (args.includes("--list")) {
  console.log(table())
} else if (args.includes("--worktrees")) {
  console.log(worktrees())
} else if (args.includes("--all")) {
  const outIdx = args.indexOf("--out")
  const dir = outIdx >= 0 ? args[outIdx + 1] : undefined
  if (!dir) throw new Error("--all requires --out <dir>")
  for (const mod of WAVE_2) {
    const path = `${dir}/${mod.migrationSlot}-${mod.slug}.md`
    await Bun.write(path, render(mod, template))
    console.log(path)
  }
} else {
  const slug = args[0]
  const mod = WAVE_2.find((m) => m.slug === slug)
  if (!mod) {
    console.error(`unknown module '${slug ?? ""}'. known: ${WAVE_2.map((m) => m.slug).join(", ")}`)
    process.exit(1)
  }
  console.log(render(mod, template))
}
