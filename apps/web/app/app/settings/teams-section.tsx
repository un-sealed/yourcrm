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
import type { Paginated, WorkspaceMember, WorkspaceTeam, WorkspaceTeamMember } from "./types"

/**
 * Teams (spec 41, P0).
 *
 * A team groups members for ownership and visibility — it grants no
 * permissions, which is why this panel never offers a workspace role. The
 * "lead" position is a label inside the team, and the badge says so.
 */

type TeamDetail = WorkspaceTeam & { members: WorkspaceTeamMember[] }

export function TeamsSection() {
  const [teams, setTeams] = useState<WorkspaceTeam[]>([])
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [selected, setSelected] = useState<TeamDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState("")
  const [addMembershipId, setAddMembershipId] = useState("")
  const [confirmDelete, setConfirmDelete] = useState<WorkspaceTeam | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [teamPage, memberPage] = await Promise.all([
        apiFetchRaw<Paginated<WorkspaceTeam>>("/api/v1/settings/teams?limit=100"),
        apiFetchRaw<Paginated<WorkspaceMember>>("/api/v1/settings/members?limit=100"),
      ])
      setTeams(teamPage.data)
      setMembers(memberPage.data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load teams.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const open = async (team: WorkspaceTeam) => {
    setActionError(null)
    try {
      setSelected(await apiFetch<TeamDetail>(`/api/v1/settings/teams/${team.id}`))
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not open that team.")
    }
  }

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setActionError(null)
    try {
      const team = await apiFetch<WorkspaceTeam>("/api/v1/settings/teams", {
        method: "POST",
        body: { name },
      })
      setName("")
      await load()
      await open(team)
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "The team could not be created.")
    } finally {
      setBusy(false)
    }
  }

  const remove = async (team: WorkspaceTeam) => {
    setBusy(true)
    setActionError(null)
    try {
      await apiFetch(`/api/v1/settings/teams/${team.id}`, { method: "DELETE" })
      if (selected?.id === team.id) setSelected(null)
      await load()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "The team could not be deleted.")
    } finally {
      setBusy(false)
      setConfirmDelete(null)
    }
  }

  const addMember = async () => {
    if (selected === null || addMembershipId === "") return
    setBusy(true)
    setActionError(null)
    try {
      await apiFetch(`/api/v1/settings/teams/${selected.id}/members`, {
        method: "POST",
        body: { membershipId: addMembershipId, teamRole: "member" },
      })
      setAddMembershipId("")
      await open(selected)
      await load()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "That member could not be added.")
    } finally {
      setBusy(false)
    }
  }

  const removeMember = async (membershipId: string) => {
    if (selected === null) return
    setBusy(true)
    setActionError(null)
    try {
      await apiFetch(`/api/v1/settings/teams/${selected.id}/members/${membershipId}`, {
        method: "DELETE",
      })
      await open(selected)
      await load()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "That member could not be removed.")
    } finally {
      setBusy(false)
    }
  }

  const candidates = members.filter(
    (member) =>
      member.active &&
      !(selected?.members ?? []).some((edge) => edge.membershipId === member.membershipId),
  )

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <section className="flex flex-1 flex-col gap-3" aria-labelledby="teams-heading">
        <h2 id="teams-heading" className="text-lg font-semibold">
          Teams
        </h2>
        <p className="text-sm text-muted-foreground">
          Teams group people for ownership and visibility. They carry no permissions — a
          member&apos;s access always comes from their workspace role.
        </p>

        <form className="flex flex-wrap items-end gap-2" onSubmit={create}>
          <Field label="New team" htmlFor="team-name" className="min-w-64">
            <TextField
              id="team-name"
              required
              value={name}
              placeholder="Field Sales EMEA"
              onChange={(e) => setName(e.currentTarget.value)}
            />
          </Field>
          <Button type="submit" disabled={busy || name.trim() === ""}>
            Create team
          </Button>
        </form>

        {actionError !== null ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {actionError}
          </p>
        ) : null}

        {loading ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading teams">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : error !== null ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : teams.length === 0 ? (
          <EmptyState
            title="No teams yet"
            description="Create your first team to group owners of records and inboxes."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {teams.map((team) => (
              <li
                key={team.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
              >
                <button
                  type="button"
                  className="text-left"
                  onClick={() => void open(team)}
                  aria-current={selected?.id === team.id ? "true" : undefined}
                >
                  <span className="font-medium text-primary hover:underline">{team.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">/{team.slug}</span>
                  <div className="text-xs text-muted-foreground">
                    {team.memberCount} member{team.memberCount === 1 ? "" : "s"}
                  </div>
                </button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirmDelete(team)}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-1 flex-col gap-3" aria-labelledby="team-detail-heading">
        <h2 id="team-detail-heading" className="text-lg font-semibold">
          {selected?.name ?? "Team members"}
        </h2>
        {selected === null ? (
          <EmptyState title="Select a team" description="Pick a team to manage its members." />
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Add member" htmlFor="team-add-member" className="min-w-64">
                <Select
                  id="team-add-member"
                  value={addMembershipId}
                  placeholder="Choose a member"
                  options={candidates.map((member) => ({
                    value: member.membershipId,
                    label: member.name ?? member.email,
                  }))}
                  onChange={(e) => setAddMembershipId(e.currentTarget.value)}
                />
              </Field>
              <Button disabled={busy || addMembershipId === ""} onClick={() => void addMember()}>
                Add
              </Button>
            </div>

            {selected.members.length === 0 ? (
              <EmptyState
                title="Nobody in this team yet"
                description="Add a workspace member above."
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {selected.members.map((edge) => (
                  <li
                    key={edge.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
                  >
                    <div>
                      <div className="font-medium">
                        {edge.name ?? edge.email ?? edge.membershipId}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        workspace role: {edge.workspaceRole ?? "unknown"}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone="outline">team {edge.teamRole}</Badge>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void removeMember(edge.membershipId)}
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title="Delete this team?"
        description={`${confirmDelete?.name ?? "The team"} is soft-deleted: its membership history stays in the audit log.`}
        confirmLabel="Delete team"
        danger
        loading={busy}
        onConfirm={() => confirmDelete !== null && void remove(confirmDelete)}
      />
    </div>
  )
}
