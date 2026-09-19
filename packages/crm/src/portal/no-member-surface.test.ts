import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { ServiceContext } from "@yourcrm/validation"
import { portalScopeFor } from "./service"
import type { PortalContext } from "./types"

/**
 * "No member surface" — the property this whole module exists to preserve.
 *
 * A portal caller must never be able to travel down a code path that was
 * written for a workspace member. There are three ways that could happen and
 * a test for each:
 *
 *  1. The module calls `requirePermission()` with a synthesised role. Guarded
 *     by the source-text assertions below: this module does not import
 *     `@yourcrm/permissions` at all, so there is nothing to call.
 *  2. A `PortalContext` is quietly passed where a `ServiceContext` is
 *     expected. Guarded by the compiler: the assignment below is a
 *     `@ts-expect-error`, so if `PortalContext` ever grows an `actorId` and a
 *     `role` — which is exactly what would make it a member context —
 *     `bun run typecheck` fails on the now-unnecessary directive.
 *  3. A portal identity gets written into `memberships` / `users`. Guarded by
 *     the source-text assertions and by the migration test in
 *     `packages/database/src/repositories/portal-repository.test.ts`.
 */

const MODULE_FILES = ["service.ts", "types.ts", "redact.ts", "schemas.ts", "index.ts"] as const

async function sourceOf(file: string): Promise<string> {
  return readFile(new URL(`./${file}`, import.meta.url), "utf8")
}

/** Strip block and line comments: the prose here discusses the banned names. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
}

describe("crm/portal: no member surface", () => {
  test("the module never imports the member permission policy", async () => {
    for (const file of MODULE_FILES) {
      const source = code(await sourceOf(file))
      expect(source, `${file} imports @yourcrm/permissions`).not.toContain("@yourcrm/permissions")
      expect(source, `${file} calls requirePermission`).not.toContain("requirePermission")
      expect(source, `${file} calls checkPermission`).not.toContain("checkPermission")
    }
  })

  test("the module never imports member auth or touches memberships", async () => {
    for (const file of MODULE_FILES) {
      const source = code(await sourceOf(file))
      expect(source, `${file} imports @yourcrm/auth`).not.toContain("@yourcrm/auth")
      expect(source, `${file} references roleInWorkspace`).not.toContain("roleInWorkspace")
      expect(source, `${file} references memberships`).not.toContain("memberships")
      expect(source, `${file} references devSession`).not.toContain("devSession")
    }
  })

  test("the service takes no ServiceContext and invents no role", async () => {
    const source = code(await sourceOf("service.ts"))
    expect(source).not.toContain("ServiceContext")
    expect(source).not.toContain("role:")
    expect(source).not.toContain("actorType")
  })

  test("a PortalContext is not assignable to a member ServiceContext", () => {
    const portal: PortalContext = {
      workspaceId: "ws-1",
      identityId: "identity-1",
      personId: "person-1",
      email: "a@example.com",
      displayName: null,
      sessionId: "session-1",
      grants: [],
    }
    // @ts-expect-error a portal identity has no actorId and no role, so it can
    // never be handed to a service method that expects a workspace member.
    const asMember: ServiceContext = portal
    expect(asMember.workspaceId).toBe("ws-1")
    expect("actorId" in portal).toBe(false)
    expect("role" in portal).toBe(false)
  })

  test("the scope compiler only ever emits ids the grants named", () => {
    const ctx: PortalContext = {
      workspaceId: "ws-1",
      identityId: "identity-1",
      personId: "person-secret",
      email: "a@example.com",
      displayName: null,
      sessionId: "session-1",
      grants: [
        {
          scopeType: "person",
          scopeId: "person-granted",
          canViewTickets: false,
          canViewInvoices: true,
          canViewQuotes: false,
        },
      ],
    }
    expect(portalScopeFor(ctx, "invoice")).toEqual({
      workspaceId: "ws-1",
      personIds: ["person-granted"],
      companyIds: [],
    })
    // The resource flags are honoured per resource, not per identity.
    expect(portalScopeFor(ctx, "ticket").personIds).toEqual([])
    expect(portalScopeFor(ctx, "quote").personIds).toEqual([])
  })
})
