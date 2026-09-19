"use client"

import { useEffect, useState } from "react"
import { ErrorState, Skeleton, Tabs } from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"
import { AuditSection } from "./audit-section"
import { MembersSection } from "./members-section"
import { PrivacySection } from "./privacy-section"
import { TeamsSection } from "./teams-section"
import { SETTINGS_SECTIONS, type SettingsSection } from "./types"
import { WorkspaceSection } from "./workspace-section"

/**
 * Settings, security & compliance (specs 40 + 41, P0).
 *
 * Five sections behind one shell: workspace profile, members + invitations,
 * teams, the append-only audit log, and GDPR/DPDP data requests.
 *
 * The page loads the caller's own membership first, and every section that
 * offers a privileged action trims itself to that role — but nothing here is
 * a security boundary. The API re-checks the role on every request and
 * re-runs the escalation guards (no self-promotion, no touching an owner
 * unless you are one, never remove the last owner), so a hand-crafted
 * request gets the same 403 this UI would have prevented.
 *
 * NOT IN P0 (spec 40 §3, reported rather than stubbed): SAML/OIDC SSO, SCIM
 * provisioning, TOTP/passkey MFA, IP allowlists and encryption-key rotation.
 * Each needs its own table and a hook in the login path; a disabled toggle
 * for them here would suggest a control that does not exist.
 */

type Me = {
  user: { id: string; email: string; name?: string | null }
  workspaceId: string | null
  memberships: { workspaceId: string; role: string }[]
}

export default function SettingsPage() {
  const [section, setSection] = useState<SettingsSection>("workspace")
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    apiFetch<Me>("/api/v1/auth/me")
      .then((data) => {
        if (active) setMe(data)
      })
      .catch((err: unknown) => {
        if (active) {
          setError(err instanceof ApiError ? err.message : "Could not load your session.")
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading settings">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-9 w-full max-w-lg" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (error !== null || me === null) {
    return (
      <ErrorState
        message={error ?? "Could not load your session."}
        onRetry={() => window.location.reload()}
      />
    )
  }

  const actorRole =
    me.memberships.find((membership) => membership.workspaceId === me.workspaceId)?.role ?? "viewer"

  const content: Record<SettingsSection, React.ReactNode> = {
    workspace: <WorkspaceSection />,
    members: <MembersSection actorRole={actorRole} actorUserId={me.user.id} />,
    teams: <TeamsSection />,
    audit: <AuditSection />,
    privacy: <PrivacySection />,
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Signed in as {me.user.name ?? me.user.email} · role {actorRole}
        </p>
      </div>

      <Tabs
        ariaLabel="Settings sections"
        value={section}
        onValueChange={(value) => setSection(value as SettingsSection)}
        items={SETTINGS_SECTIONS.map((item) => ({
          value: item.value,
          label: item.label,
          content: content[item.value],
        }))}
      />
    </div>
  )
}
