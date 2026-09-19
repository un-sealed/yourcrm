"use client"

import { useCallback, useEffect, useState } from "react"
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Select,
  Skeleton,
  TextField,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  assignableRoles,
  formatSettingsTimestamp,
  inviteState,
  inviteStateTone,
  memberStatusLabel,
  roleTone,
  type Paginated,
  type WorkspaceInvite,
  type WorkspaceMember,
} from "./types"

/**
 * Members and invitations (spec 41, P0).
 *
 * The role dropdown and the hidden actions are ergonomics only. Every rule
 * that matters — you cannot promote yourself, you cannot re-rank an owner
 * unless you are one, you cannot remove the last owner — is enforced by the
 * API, and this component shows the server's refusal verbatim instead of
 * guessing why it failed.
 *
 * An invite link is shown EXACTLY ONCE, right after it is minted: the
 * server stores only a hash, so nobody (including this page, on reload) can
 * ever display it again. That is why it gets a copy affordance rather than
 * a quiet toast.
 */

type Props = {
  /** The signed-in user's role, used to trim the role menu. */
  actorRole: string
  /** The signed-in user's id, so the UI can mark "you" and hide self-actions. */
  actorUserId: string
}

type Pending = { member: WorkspaceMember; next: boolean } | null

export function MembersSection({ actorRole, actorUserId }: Props) {
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [invites, setInvites] = useState<WorkspaceInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteRole, setInviteRole] = useState("member")
  const [issuedLink, setIssuedLink] = useState<{ email: string; token: string } | null>(null)
  const [search, setSearch] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ limit: "100" })
      if (search.trim() !== "") params.set("query", search.trim())
      const [memberPage, invitePage] = await Promise.all([
        apiFetchRaw<Paginated<WorkspaceMember>>(`/api/v1/settings/members?${params.toString()}`),
        apiFetchRaw<Paginated<WorkspaceInvite>>("/api/v1/settings/invites?limit=100"),
      ])
      setMembers(memberPage.data)
      setInvites(invitePage.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load workspace members.")
    } finally {
      setLoading(false)
    }
  }, [search])

  useEffect(() => {
    void load()
  }, [load])

  const changeRole = async (member: WorkspaceMember, role: string) => {
    setBusyId(member.membershipId)
    setActionError(null)
    try {
      await apiFetch(`/api/v1/settings/members/${member.membershipId}/role`, {
        method: "PATCH",
        body: { role },
      })
      await load()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "That role change was rejected.")
    } finally {
      setBusyId(null)
    }
  }

  const setActive = async (member: WorkspaceMember, next: boolean) => {
    setBusyId(member.membershipId)
    setActionError(null)
    try {
      await apiFetch(
        `/api/v1/settings/members/${member.membershipId}/${next ? "reactivate" : "deactivate"}`,
        { method: "POST" },
      )
      await load()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "That change was rejected.")
    } finally {
      setBusyId(null)
      setPending(null)
    }
  }

  const sendInvite = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setActionError(null)
    setBusyId("invite")
    try {
      const created = await apiFetch<WorkspaceInvite & { token: string }>(
        "/api/v1/settings/invites",
        { method: "POST", body: { email: inviteEmail, role: inviteRole } },
      )
      setIssuedLink({ email: created.email, token: created.token })
      setInviteEmail("")
      await load()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "The invitation could not be sent.")
    } finally {
      setBusyId(null)
    }
  }

  const resend = async (invite: WorkspaceInvite) => {
    setBusyId(invite.id)
    setActionError(null)
    try {
      const rotated = await apiFetch<WorkspaceInvite & { token: string }>(
        `/api/v1/settings/invites/${invite.id}/resend`,
        { method: "POST" },
      )
      setIssuedLink({ email: rotated.email, token: rotated.token })
      await load()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "The invitation could not be resent.")
    } finally {
      setBusyId(null)
    }
  }

  const revoke = async (invite: WorkspaceInvite) => {
    setBusyId(invite.id)
    setActionError(null)
    try {
      await apiFetch(`/api/v1/settings/invites/${invite.id}`, { method: "DELETE" })
      await load()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "The invitation could not be revoked.")
    } finally {
      setBusyId(null)
    }
  }

  const roleOptions = assignableRoles(actorRole).map((role) => ({ value: role, label: role }))

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-labelledby="members-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="members-heading" className="text-lg font-semibold">
            Members
          </h2>
          <TextField
            aria-label="Search members"
            placeholder="Search by name or email"
            value={search}
            className="w-64"
            onChange={(e) => setSearch(e.currentTarget.value)}
          />
        </div>

        {actionError !== null ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {actionError}
          </p>
        ) : null}

        {loading ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading members">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : error !== null ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : members.length === 0 ? (
          <EmptyState
            title="No members match"
            description="Invite a teammate below, or clear the search."
          />
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">Workspace members and their roles</caption>
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Member
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Role
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Last sign-in
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => {
                  const isSelf = member.userId === actorUserId
                  return (
                    <tr key={member.membershipId} className="border-t border-border">
                      <td className="px-3 py-2">
                        <div className="font-medium">
                          {member.name ?? member.email}
                          {isSelf ? (
                            <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                          ) : null}
                        </div>
                        <div className="text-xs text-muted-foreground">{member.email}</div>
                      </td>
                      <td className="px-3 py-2">
                        {isSelf ? (
                          <Badge tone={roleTone(member.role)}>{member.role}</Badge>
                        ) : (
                          <Select
                            aria-label={`Role for ${member.email}`}
                            value={member.role}
                            className="w-32"
                            disabled={busyId === member.membershipId || roleOptions.length === 0}
                            options={
                              roleOptions.some((option) => option.value === member.role)
                                ? roleOptions
                                : [{ value: member.role, label: member.role }, ...roleOptions]
                            }
                            onChange={(e) => void changeRole(member, e.currentTarget.value)}
                          />
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={member.active ? "success" : "secondary"}>
                          {memberStatusLabel(member)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {formatSettingsTimestamp(member.lastLoginAt)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {isSelf ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <Button
                            size="sm"
                            variant={member.active ? "outline" : "secondary"}
                            disabled={busyId === member.membershipId}
                            onClick={() => setPending({ member, next: !member.active })}
                          >
                            {member.active ? "Deactivate" : "Reactivate"}
                          </Button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="invites-heading">
        <h2 id="invites-heading" className="text-lg font-semibold">
          Invitations
        </h2>

        <form className="flex flex-wrap items-end gap-2" onSubmit={sendInvite}>
          <Field label="Email" htmlFor="invite-email" className="min-w-64">
            <TextField
              id="invite-email"
              type="email"
              required
              value={inviteEmail}
              placeholder="teammate@example.com"
              onChange={(e) => setInviteEmail(e.currentTarget.value)}
            />
          </Field>
          <Field label="Role" htmlFor="invite-role">
            <Select
              id="invite-role"
              value={inviteRole}
              className="w-32"
              options={roleOptions}
              onChange={(e) => setInviteRole(e.currentTarget.value)}
            />
          </Field>
          <Button type="submit" disabled={busyId === "invite" || inviteEmail.trim() === ""}>
            {busyId === "invite" ? "Inviting…" : "Send invite"}
          </Button>
        </form>

        {issuedLink !== null ? (
          <div
            role="status"
            className="flex flex-col gap-1 rounded-md border border-border bg-muted/40 p-3"
          >
            <p className="text-sm font-medium">
              Invitation link for {issuedLink.email} — copy it now.
            </p>
            <p className="text-xs text-muted-foreground">
              Only a hash is stored, so this link cannot be shown again. Resend to mint a new one.
            </p>
            <code className="break-all rounded bg-background p-2 text-xs">
              {`/signup?invite=${issuedLink.token}`}
            </code>
            <div>
              <Button size="sm" variant="ghost" onClick={() => setIssuedLink(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        ) : null}

        {loading ? (
          <Skeleton className="h-12 w-full" />
        ) : invites.length === 0 ? (
          <EmptyState
            title="No pending invitations"
            description="Invited people appear here until they accept or the invite expires."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {invites.map((invite) => {
              const state = inviteState(invite)
              return (
                <li
                  key={invite.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
                >
                  <div>
                    <div className="font-medium">{invite.email}</div>
                    <div className="text-xs text-muted-foreground">
                      {invite.role} · expires {formatSettingsTimestamp(invite.expiresAt)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={inviteStateTone(state)}>{state}</Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === invite.id}
                      onClick={() => void resend(invite)}
                    >
                      Resend
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === invite.id}
                      onClick={() => void revoke(invite)}
                    >
                      Revoke
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending?.next === true ? "Reactivate this member?" : "Deactivate this member?"}
        description={
          pending?.next === true
            ? `${pending.member.email} will be able to sign in again.`
            : `${pending?.member.email ?? "This member"} will lose access immediately. Their records, teams and audit history are kept.`
        }
        confirmLabel={pending?.next === true ? "Reactivate" : "Deactivate"}
        danger={pending?.next !== true}
        loading={busyId !== null}
        onConfirm={() => pending !== null && void setActive(pending.member, pending.next)}
      />
    </div>
  )
}
