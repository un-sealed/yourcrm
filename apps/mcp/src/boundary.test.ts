import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

/**
 * PROPERTY 3 — no table access, asserted from the source text.
 *
 * `AGENTS.md` and `docs/architecture.md` both state the rule: *MCP tools
 * consume domain services, never tables.* A typecheck cannot prove that —
 * an import would simply compile — so the boundary is asserted the only
 * way a boundary can be: by reading what this app is allowed to mention.
 *
 * Every needle is assembled from fragments by {@link needle}, so this file
 * never contains one literally and is therefore scanned along with the
 * rest of the app rather than exempting itself.
 */

const SRC = import.meta.dir

function sourceFiles(): { name: string; text: string }[] {
  return readdirSync(SRC)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(SRC, name), "utf8") }))
}

/** Assemble a forbidden string without writing it down. See the header. */
function needle(...parts: string[]): string {
  return parts.join("")
}

const DATABASE_PACKAGE = needle("@yourcrm", "/", "data", "base")

describe("mcp/boundary", () => {
  test("the app scans its own source (guard against an empty assertion)", () => {
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(5)
    expect(files.map((file) => file.name)).toContain("tools.ts")
    expect(files.map((file) => file.name)).toContain("boundary.test.ts")
  })

  test("no file reaches for the database package, its repositories or its schema", () => {
    const forbidden = [
      DATABASE_PACKAGE,
      needle("driz", "zle"),
      needle("reposi", "tories/"),
      needle("select ", "* from"),
      needle("pg", "-core"),
    ]
    for (const file of sourceFiles()) {
      for (const entry of forbidden) {
        expect(file.text.toLowerCase(), `${file.name} / ${entry}`).not.toContain(
          entry.toLowerCase(),
        )
      }
    }
  })

  test("the manifest does not declare the database package", () => {
    const manifest = readFileSync(join(SRC, "..", "package.json"), "utf8")
    expect(manifest).not.toContain(DATABASE_PACKAGE)
    // The domain package it *does* depend on is the point.
    expect(manifest).toContain(needle("@yourcrm", "/", "crm"))
  })

  /**
   * The propose-only port is a type, and a type is erased at runtime — so
   * the guarantee "no MCP tool can approve or apply an AI action" is also
   * pinned here, where a future edit reaching for a decision method fails
   * the build rather than the review. `dev-runtime.ts` is exempt because
   * it is where the applier is deliberately wired to throw.
   */
  test("nothing in the app approves, applies or reverts an AI action", () => {
    const forbidden = [
      needle("governance.", "approve"),
      needle("governance.", "apply"),
      needle("governance.", "reject"),
      needle("governance.", "revert"),
      needle("apply", "AiAction"),
      needle("revert", "AiAction"),
    ]
    for (const file of sourceFiles()) {
      if (file.name === "dev-runtime.ts" || file.name.endsWith(".test.ts")) continue
      for (const entry of forbidden) {
        expect(file.text, `${file.name} / ${entry}`).not.toContain(entry)
      }
    }
  })

  /**
   * P0 is stdio. An HTTP/SSE transport needs the OAuth design spec 39 §7
   * calls for and a public surface this repo does not have, so its absence
   * is a decision, recorded here.
   */
  test("the transport is stdio only — no HTTP surface was added", () => {
    const forbidden = [
      needle("Streamable", "HTTPServerTransport"),
      needle("SSE", "ServerTransport"),
      needle("expr", "ess"),
      needle("ho", "no"),
    ]
    for (const file of sourceFiles()) {
      for (const entry of forbidden) {
        expect(file.text, `${file.name} / ${entry}`).not.toContain(entry)
      }
    }
  })

  test("no escape hatches: the app holds itself to the repo's own rules", () => {
    const forbidden = [
      needle("@ts-", "ignore"),
      needle("@ts-", "expect-error"),
      needle("eslint-", "disable"),
      needle("as ", "any"),
      needle(": ", "any"),
      needle(".sk", "ip("),
      needle(".to", "do("),
    ]
    for (const file of sourceFiles()) {
      for (const entry of forbidden) {
        expect(file.text, `${file.name} / ${entry}`).not.toContain(entry)
      }
    }
  })
})
