import { describe, expect, test } from "bun:test"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { makeBaseRecord, makeServiceContext, makeSession } from "@yourcrm/testing"
import { assertAppScopeGranted, partitionScopesByInstallerPermission } from "./access"
import type { AppScope, AppScopeGrant } from "./types"

const REQUESTED: AppScope[] = [
  { object: "person", action: "read" },
  { object: "person", action: "delete" },
]

/**
 * Isolated tests of the capping/enforcement policy, independent of the
 * service's own "who may call install() at all" gate (admin-level, per the
 * module spec). This matters because every `PERMISSION_ACTION` tops out at
 * rank 80 ("admin"/"delete"/"run_automation" all tie) — so any actor who
 * clears the install gate ALSO clears every individual scope's rank
 * requirement, and the capping behaviour is otherwise invisible end-to-end
 * through `service.install()`. Testing the pure policy function directly is
 * what actually exercises "narrower wins" for a sub-admin caller — e.g. an
 * `assertScope` call made on behalf of a non-admin actor, or a future
 * lower-gated install path.
 */
describe("marketplace/access: partitionScopesByInstallerPermission", () => {
  test("PROPERTY: a viewer installing an app that requests delete does not get delete", () => {
    const ctx = makeServiceContext({ session: makeSession({ role: "viewer" }) })
    const { granted, denied } = partitionScopesByInstallerPermission(ctx, REQUESTED)
    expect(granted).toEqual([{ object: "person", action: "read" }])
    expect(denied).toEqual([{ object: "person", action: "delete" }])
  })

  test("a member (rank 40) is capped the same way as a viewer for delete", () => {
    const ctx = makeServiceContext({ session: makeSession({ role: "member" }) })
    const { granted, denied } = partitionScopesByInstallerPermission(ctx, REQUESTED)
    expect(granted.map((s) => s.action)).toEqual(["read"])
    expect(denied.map((s) => s.action)).toEqual(["delete"])
  })

  test("an admin (rank 80) clears every requested scope", () => {
    const ctx = makeServiceContext({ session: makeSession({ role: "admin" }) })
    const { granted, denied } = partitionScopesByInstallerPermission(ctx, REQUESTED)
    expect(granted).toEqual(REQUESTED)
    expect(denied).toEqual([])
  })

  test("never grants more than was requested, even for an owner", () => {
    const ctx = makeServiceContext({ session: makeSession({ role: "owner" }) })
    const { granted } = partitionScopesByInstallerPermission(ctx, [
      { object: "person", action: "read" },
    ])
    expect(granted).toEqual([{ object: "person", action: "read" }])
  })
})

describe("marketplace/access: assertAppScopeGranted", () => {
  const workspaceId = "ws_1"
  const installationId = "inst_1"

  function grant(object: string, action: string): AppScopeGrant {
    return {
      ...makeBaseRecord({ workspaceId }),
      installationId,
      object,
      action,
    }
  }

  test("PROPERTY: an app cannot act outside its granted scopes", () => {
    const grants = [grant("person", "read")]
    expect(() =>
      assertAppScopeGranted({ workspaceId, installationId }, grants, "person", "delete"),
    ).toThrow(PermissionDeniedError)
    expect(() =>
      assertAppScopeGranted({ workspaceId, installationId }, grants, "deal", "update"),
    ).toThrow(PermissionDeniedError)
  })

  test("allows exactly the granted (object, action) pair", () => {
    const grants = [grant("person", "read")]
    expect(() =>
      assertAppScopeGranted({ workspaceId, installationId }, grants, "person", "read"),
    ).not.toThrow()
  })

  test("PROPERTY: revoked (empty) grants deny everything", () => {
    expect(() =>
      assertAppScopeGranted({ workspaceId, installationId }, [], "person", "read"),
    ).toThrow(PermissionDeniedError)
  })
})
