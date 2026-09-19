"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  Badge,
  Button,
  ConfirmDialog,
  DatePicker,
  EmptyState,
  ErrorState,
  Field,
  RecordHeader,
  Select,
  Skeleton,
  Tabs,
  TextField,
  toast,
} from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"
import {
  CS_LIFECYCLE_OPTIONS,
  formatCurrency,
  formatDate,
  formatScore,
  healthTone,
  lifecycleTone,
  type CsAccount,
  type CsHealthScore,
  type CsPlaybookCatalogEntry,
  type CsPlaybookTaskList,
  type CsRenewal,
  type CsRenewalListResponse,
} from "../types"

const RENEWAL_STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
]

export default function CustomerSuccessAccountDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id

  const [account, setAccount] = useState<CsAccount | null>(null)
  const [healthHistory, setHealthHistory] = useState<CsHealthScore[]>([])
  const [renewals, setRenewals] = useState<CsRenewal[]>([])
  const [playbooks, setPlaybooks] = useState<CsPlaybookCatalogEntry[]>([])
  const [playbookTasks, setPlaybookTasks] = useState<CsPlaybookTaskList>({ links: [], tasks: [] })
  const [tab, setTab] = useState("overview")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [lifecycleStage, setLifecycleStage] = useState("onboarding")
  const [arr, setArr] = useState("")
  const [renewalDate, setRenewalDate] = useState("")
  const [notes, setNotes] = useState("")
  const [saving, setSaving] = useState(false)
  const [recomputing, setRecomputing] = useState(false)

  const [selectedPlaybook, setSelectedPlaybook] = useState("")
  const [applyingPlaybook, setApplyingPlaybook] = useState(false)

  const [newRenewalDate, setNewRenewalDate] = useState("")
  const [newRenewalRisk, setNewRenewalRisk] = useState(false)
  const [creatingRenewal, setCreatingRenewal] = useState(false)

  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [accountData, history, renewalList, catalogue, tasks] = await Promise.all([
        apiFetch<CsAccount>(`/api/v1/customer-success/accounts/${id}`),
        apiFetch<CsHealthScore[]>(`/api/v1/customer-success/accounts/${id}/health-scores`),
        apiFetch<CsRenewalListResponse>(`/api/v1/customer-success/renewals?accountId=${id}`),
        apiFetch<CsPlaybookCatalogEntry[]>("/api/v1/customer-success/playbooks"),
        apiFetch<CsPlaybookTaskList>(`/api/v1/customer-success/accounts/${id}/playbook-tasks`),
      ])
      setAccount(accountData)
      setLifecycleStage(accountData.lifecycleStage)
      setArr(accountData.arr ?? "")
      setRenewalDate(accountData.renewalDate ?? "")
      setNotes(accountData.notes ?? "")
      setHealthHistory(history)
      setRenewals(renewalList.data)
      setPlaybooks(catalogue)
      setPlaybookTasks(tasks)
      if (catalogue[0]) setSelectedPlaybook((prev) => prev || (catalogue[0]?.key ?? ""))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this account.")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const updated = await apiFetch<CsAccount>(`/api/v1/customer-success/accounts/${id}`, {
        method: "PATCH",
        body: {
          lifecycleStage,
          ...(arr.trim() === "" ? { arr: null } : { arr: Number(arr) }),
          ...(renewalDate.trim() === "" ? { renewalDate: null } : { renewalDate }),
          notes: notes.trim() === "" ? null : notes.trim(),
        },
      })
      setAccount(updated)
      toast({ title: "Account updated" })
    } catch (err) {
      toast({
        title: "Update failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setSaving(false)
    }
  }

  const recompute = async () => {
    setRecomputing(true)
    try {
      await apiFetch<CsHealthScore>(`/api/v1/customer-success/accounts/${id}/health-scores`, {
        method: "POST",
      })
      toast({ title: "Health score recomputed" })
      await load()
    } catch (err) {
      toast({
        title: "Recompute failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setRecomputing(false)
    }
  }

  const applyPlaybook = async () => {
    if (selectedPlaybook === "") return
    setApplyingPlaybook(true)
    try {
      await apiFetch(`/api/v1/customer-success/accounts/${id}/playbooks/apply`, {
        method: "POST",
        body: { playbookKey: selectedPlaybook },
      })
      toast({ title: "Playbook applied", description: "Tasks were created for this account." })
      await load()
    } catch (err) {
      toast({
        title: "Could not apply playbook",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setApplyingPlaybook(false)
    }
  }

  const createRenewal = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newRenewalDate.trim() === "") return
    setCreatingRenewal(true)
    try {
      await apiFetch("/api/v1/customer-success/renewals", {
        method: "POST",
        body: { accountId: id, renewalDate: newRenewalDate, riskFlag: newRenewalRisk },
      })
      toast({ title: "Renewal added" })
      setNewRenewalDate("")
      setNewRenewalRisk(false)
      await load()
    } catch (err) {
      toast({
        title: "Could not add renewal",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setCreatingRenewal(false)
    }
  }

  const remove = async () => {
    try {
      await apiFetch(`/api/v1/customer-success/accounts/${id}`, { method: "DELETE" })
      toast({ title: "Account deleted", description: "It can be restored from trash." })
      router.push("/app/customer-success")
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading account">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error !== null || account === null) {
    return (
      <ErrorState message={error ?? "This account does not exist."} onRetry={() => void load()} />
    )
  }

  const latest = healthHistory[0] ?? null

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/customer-success" className="text-sm text-muted-foreground hover:underline">
        ← Back to customer success
      </Link>
      <RecordHeader
        title={account.companyId}
        subtitle={`ARR ${formatCurrency(account.arr)} · Renewal ${formatDate(account.renewalDate)}`}
        status={{
          label: account.lifecycleStage.replace("_", " "),
          tone: lifecycleTone(account.lifecycleStage),
        }}
        owner={account.ownerId ? { name: account.ownerId } : undefined}
        actions={
          <>
            {latest ? (
              <Badge tone={healthTone(Number(latest.score))}>
                Health {formatScore(latest.score)}
              </Badge>
            ) : (
              <Badge tone="secondary">No health score yet</Badge>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void recompute()}
              disabled={recomputing}
            >
              {recomputing ? "Recomputing…" : "Recompute health"}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </>
        }
      />

      <Tabs
        value={tab}
        onValueChange={setTab}
        ariaLabel="Account sections"
        items={[
          {
            value: "overview",
            label: "Overview",
            content: (
              <div className="grid gap-6 py-4 lg:grid-cols-2">
                <section aria-label="Account details" className="flex flex-col gap-3">
                  <h2 className="text-sm font-semibold">Details</h2>
                  <dl className="flex flex-col gap-2 text-sm">
                    <div className="flex items-center gap-2">
                      <dt className="w-24 shrink-0 text-muted-foreground">Company</dt>
                      <dd>{account.companyId}</dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-24 shrink-0 text-muted-foreground">Owner</dt>
                      <dd>{account.ownerId ?? "Unassigned"}</dd>
                    </div>
                  </dl>
                  {account.notes ? (
                    <div className="flex flex-col gap-1">
                      <h3 className="text-sm font-semibold">Notes</h3>
                      <p className="whitespace-pre-wrap text-sm">{account.notes}</p>
                    </div>
                  ) : null}
                </section>
                <section aria-label="Edit account">
                  <h2 className="mb-3 text-sm font-semibold">Edit</h2>
                  <form onSubmit={save} className="flex flex-col gap-3">
                    <Field label="Lifecycle stage" htmlFor="edit-lifecycle">
                      <Select
                        id="edit-lifecycle"
                        value={lifecycleStage}
                        onChange={(e) => setLifecycleStage(e.currentTarget.value)}
                        options={CS_LIFECYCLE_OPTIONS}
                      />
                    </Field>
                    <Field label="ARR" htmlFor="edit-arr">
                      <TextField
                        id="edit-arr"
                        type="number"
                        min="0"
                        step="0.01"
                        value={arr}
                        onChange={(e) => setArr(e.currentTarget.value)}
                      />
                    </Field>
                    <Field label="Renewal date" htmlFor="edit-renewal-date">
                      <DatePicker
                        id="edit-renewal-date"
                        value={renewalDate}
                        onChange={(e) => setRenewalDate(e.currentTarget.value)}
                      />
                    </Field>
                    <Field label="Notes" htmlFor="edit-notes">
                      <TextField
                        id="edit-notes"
                        value={notes}
                        onChange={(e) => setNotes(e.currentTarget.value)}
                      />
                    </Field>
                    <div>
                      <Button type="submit" disabled={saving}>
                        {saving ? "Saving…" : "Save changes"}
                      </Button>
                    </div>
                  </form>
                </section>
              </div>
            ),
          },
          {
            value: "health",
            label: "Health",
            content: (
              <div className="flex flex-col gap-6 py-4">
                {latest ? (
                  <section aria-label="Latest health factors" className="flex flex-col gap-2">
                    <h2 className="text-sm font-semibold">
                      Latest score: {formatScore(latest.score)} (computed{" "}
                      {formatDate(latest.computedAt)})
                    </h2>
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground">
                          <th className="py-1 pr-2 font-medium">Factor</th>
                          <th className="py-1 pr-2 font-medium">Raw value</th>
                          <th className="py-1 pr-2 font-medium">Score</th>
                          <th className="py-1 pr-2 font-medium">Weight</th>
                          <th className="py-1 font-medium">Contribution</th>
                        </tr>
                      </thead>
                      <tbody>
                        {latest.factors.map((factor) => (
                          <tr key={factor.key} className="border-b border-border/50">
                            <td className="py-1 pr-2">{factor.label}</td>
                            <td className="py-1 pr-2">{factor.rawValue ?? "—"}</td>
                            <td className="py-1 pr-2">{factor.normalizedScore.toFixed(1)}</td>
                            <td className="py-1 pr-2">{factor.weight}</td>
                            <td className="py-1">{factor.contribution.toFixed(1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                ) : (
                  <EmptyState
                    title="No health score yet"
                    description="Recompute to score this account from recent activity and open deals."
                    action={
                      <Button onClick={() => void recompute()} disabled={recomputing}>
                        {recomputing ? "Recomputing…" : "Recompute health"}
                      </Button>
                    }
                  />
                )}
                {healthHistory.length > 1 ? (
                  <section aria-label="Health history" className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold">History</h3>
                    <ul className="flex flex-col gap-1 text-sm">
                      {healthHistory.map((entry) => (
                        <li key={entry.id} className="flex items-center gap-2">
                          <Badge tone={healthTone(Number(entry.score))}>
                            {formatScore(entry.score)}
                          </Badge>
                          <span className="text-muted-foreground">
                            {formatDate(entry.computedAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </div>
            ),
          },
          {
            value: "renewals",
            label: "Renewals",
            content: (
              <div className="flex flex-col gap-6 py-4">
                {renewals.length === 0 ? (
                  <EmptyState
                    title="No renewals tracked"
                    description="Add a renewal date to start tracking this account's next contract cycle."
                  />
                ) : (
                  <ul className="flex flex-col gap-2 text-sm">
                    {renewals.map((renewal) => (
                      <li
                        key={renewal.id}
                        className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2"
                      >
                        <span className="font-medium">{formatDate(renewal.renewalDate)}</span>
                        <Badge
                          tone={
                            renewal.status === "won"
                              ? "success"
                              : renewal.status === "lost"
                                ? "destructive"
                                : "secondary"
                          }
                        >
                          {renewal.status}
                        </Badge>
                        {renewal.riskFlag ? <Badge tone="warning">At risk</Badge> : null}
                        <span className="text-muted-foreground">{formatCurrency(renewal.arr)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <form onSubmit={createRenewal} className="flex flex-wrap items-end gap-3">
                  <Field label="Renewal date" htmlFor="new-renewal-date">
                    <DatePicker
                      id="new-renewal-date"
                      value={newRenewalDate}
                      onChange={(e) => setNewRenewalDate(e.currentTarget.value)}
                      required
                    />
                  </Field>
                  <Field label="Status" htmlFor="new-renewal-status">
                    <Select
                      id="new-renewal-status"
                      value="open"
                      onChange={() => undefined}
                      options={RENEWAL_STATUS_OPTIONS}
                    />
                  </Field>
                  <label className="flex items-center gap-2 pb-2 text-sm">
                    <input
                      type="checkbox"
                      checked={newRenewalRisk}
                      onChange={(e) => setNewRenewalRisk(e.currentTarget.checked)}
                    />
                    At risk
                  </label>
                  <Button type="submit" disabled={creatingRenewal || newRenewalDate.trim() === ""}>
                    {creatingRenewal ? "Adding…" : "Add renewal"}
                  </Button>
                </form>
              </div>
            ),
          },
          {
            value: "playbooks",
            label: "Playbooks",
            content: (
              <div className="flex flex-col gap-6 py-4">
                <section aria-label="Apply a playbook" className="flex flex-wrap items-end gap-3">
                  <Field label="Playbook" htmlFor="playbook-select">
                    <Select
                      id="playbook-select"
                      value={selectedPlaybook}
                      onChange={(e) => setSelectedPlaybook(e.currentTarget.value)}
                      options={playbooks.map((p) => ({
                        value: p.key,
                        label: `${p.label} (${p.taskCount})`,
                      }))}
                    />
                  </Field>
                  <Button
                    onClick={() => void applyPlaybook()}
                    disabled={applyingPlaybook || selectedPlaybook === ""}
                  >
                    {applyingPlaybook ? "Applying…" : "Apply playbook"}
                  </Button>
                </section>
                {playbookTasks.links.length === 0 ? (
                  <EmptyState
                    title="No playbooks applied yet"
                    description="Applying a playbook creates real tasks for this account's company."
                  />
                ) : (
                  <ul className="flex flex-col gap-2 text-sm">
                    {playbookTasks.links.map((link) => {
                      const task = playbookTasks.tasks.find((t) => t.id === link.taskId)
                      return (
                        <li
                          key={link.id}
                          className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2"
                        >
                          <Badge tone="secondary">{link.playbookKey}</Badge>
                          <span>{task?.title ?? link.taskId}</span>
                          {task?.status ? (
                            <span className="text-muted-foreground">{task.status}</span>
                          ) : null}
                          <Link
                            href={`/app/tasks/${link.taskId}`}
                            className="ml-auto text-primary hover:underline"
                          >
                            View task
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            ),
          },
        ]}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${account.companyId}?`}
        description="The account moves to trash and can be restored."
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  )
}
