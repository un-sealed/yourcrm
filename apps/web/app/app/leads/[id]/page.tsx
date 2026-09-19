"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  RecordHeader,
  Skeleton,
  Tabs,
  TextField,
  Timeline,
  toast,
} from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"
import {
  LeadForm,
  formValuesToBody,
  leadToFormValues,
  type LeadFormValues,
} from "../_components/lead-form"
import { displayName, statusTone, type Lead } from "../_components/types"

/** Lead detail: header, tabbed overview/timeline, inline edit, lifecycle actions. */
export default function LeadDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id
  const [lead, setLead] = useState<Lead | null>(null)
  const [tab, setTab] = useState("overview")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [convertOpen, setConvertOpen] = useState(false)
  const [convertSaving, setConvertSaving] = useState(false)
  const [personId, setPersonId] = useState("")
  const [companyId, setCompanyId] = useState("")
  const [dealId, setDealId] = useState("")
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<Lead>(`/api/v1/leads/${id}`)
      setLead(data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this lead.")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (values: LeadFormValues) => {
    if (values.firstName.trim() === "") {
      setEditError("First name is required.")
      return
    }
    setEditError(null)
    setSaving(true)
    try {
      const updated = await apiFetch<Lead>(`/api/v1/leads/${id}`, {
        method: "PATCH",
        body: formValuesToBody(values),
      })
      setLead(updated)
      toast({ title: "Lead updated" })
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : "Could not update the lead.")
    } finally {
      setSaving(false)
    }
  }

  const qualify = async () => {
    setActionError(null)
    try {
      const updated = await apiFetch<Lead>(`/api/v1/leads/${id}/qualify`, { method: "POST" })
      setLead(updated)
      toast({ title: "Lead qualified" })
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not qualify the lead.")
    }
  }

  const convert = async (e: React.FormEvent) => {
    e.preventDefault()
    setConvertSaving(true)
    try {
      const updated = await apiFetch<Lead>(`/api/v1/leads/${id}/convert`, {
        method: "POST",
        body: {
          ...(personId.trim() === "" ? {} : { personId: personId.trim() }),
          ...(companyId.trim() === "" ? {} : { companyId: companyId.trim() }),
          ...(dealId.trim() === "" ? {} : { dealId: dealId.trim() }),
        },
      })
      setLead(updated)
      setConvertOpen(false)
      toast({ title: "Lead converted" })
    } catch (err) {
      toast({
        title: "Convert failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setConvertSaving(false)
    }
  }

  const remove = async () => {
    try {
      await apiFetch(`/api/v1/leads/${id}`, { method: "DELETE" })
      toast({ title: "Lead deleted", description: "It can be restored from trash." })
      router.push("/app/leads")
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading lead">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error !== null || lead === null) {
    return <ErrorState message={error ?? "This lead does not exist."} onRetry={() => void load()} />
  }

  const converted = lead.status === "converted"
  const qualified = lead.status === "qualified"

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/leads" className="text-sm text-muted-foreground hover:underline">
        ← Back to leads
      </Link>
      <RecordHeader
        title={displayName(lead)}
        subtitle={lead.companyName ?? lead.title ?? "No company"}
        status={{ label: lead.status, tone: statusTone(lead.status) }}
        owner={undefined}
        actions={
          <>
            {qualified || converted ? null : (
              <Button variant="outline" size="sm" onClick={() => void qualify()}>
                Qualify
              </Button>
            )}
            {converted ? null : (
              <Button variant="outline" size="sm" onClick={() => setConvertOpen(true)}>
                Convert
              </Button>
            )}
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </>
        }
      />
      {actionError !== null ? (
        <ErrorState message={actionError} onRetry={() => void load()} />
      ) : null}

      <Tabs
        value={tab}
        onValueChange={setTab}
        ariaLabel="Lead sections"
        items={[
          {
            value: "overview",
            label: "Overview",
            content: (
              <div className="grid gap-6 py-4 lg:grid-cols-2">
                <section aria-label="Contact" className="flex flex-col gap-3">
                  <h2 className="text-sm font-semibold">Contact</h2>
                  <dl className="flex flex-col gap-2 text-sm">
                    <div className="flex items-center gap-2">
                      <dt className="w-20 shrink-0 text-muted-foreground">Email</dt>
                      <dd>{lead.email ?? "—"}</dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-20 shrink-0 text-muted-foreground">Phone</dt>
                      <dd>{lead.phone ?? "—"}</dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-20 shrink-0 text-muted-foreground">Company</dt>
                      <dd>{lead.companyName ?? "—"}</dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-20 shrink-0 text-muted-foreground">Title</dt>
                      <dd>{lead.title ?? "—"}</dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-20 shrink-0 text-muted-foreground">Source</dt>
                      <dd>{lead.source}</dd>
                    </div>
                  </dl>
                  <h2 className="text-sm font-semibold">Qualification</h2>
                  <dl className="flex flex-col gap-2 text-sm">
                    <div className="flex items-center gap-2">
                      <dt className="w-20 shrink-0 text-muted-foreground">Status</dt>
                      <dd>
                        <Badge tone={statusTone(lead.status)}>{lead.status}</Badge>
                      </dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-20 shrink-0 text-muted-foreground">Score</dt>
                      <dd className="tabular-nums">{lead.score} / 100</dd>
                    </div>
                  </dl>
                  {lead.notes ? (
                    <div className="flex flex-col gap-1">
                      <h3 className="text-sm font-semibold">Notes</h3>
                      <p className="whitespace-pre-wrap text-sm">{lead.notes}</p>
                    </div>
                  ) : null}
                </section>
                <section aria-label="Edit lead" className="flex flex-col gap-3">
                  <h2 className="text-sm font-semibold">Edit</h2>
                  <LeadForm
                    key={lead.updatedAt}
                    initial={leadToFormValues(lead)}
                    saving={saving}
                    fieldError={editError}
                    submitLabel="Save changes"
                    onSubmit={(values) => void save(values)}
                  />
                </section>
                <section aria-label="Related records" className="flex flex-col gap-3 lg:col-span-2">
                  <h2 className="text-sm font-semibold">Related records</h2>
                  {lead.personId === null && lead.companyId === null && lead.dealId === null ? (
                    <EmptyState
                      title="Nothing linked yet"
                      description="Converting this lead stores the linked person, company and deal ids here."
                    />
                  ) : (
                    <dl className="flex flex-col gap-2 text-sm">
                      <div className="flex items-center gap-2">
                        <dt className="w-20 shrink-0 text-muted-foreground">Person</dt>
                        <dd className="font-mono text-xs">{lead.personId ?? "—"}</dd>
                      </div>
                      <div className="flex items-center gap-2">
                        <dt className="w-20 shrink-0 text-muted-foreground">Company</dt>
                        <dd className="font-mono text-xs">{lead.companyId ?? "—"}</dd>
                      </div>
                      <div className="flex items-center gap-2">
                        <dt className="w-20 shrink-0 text-muted-foreground">Deal</dt>
                        <dd className="font-mono text-xs">{lead.dealId ?? "—"}</dd>
                      </div>
                    </dl>
                  )}
                </section>
              </div>
            ),
          },
          {
            value: "activity",
            label: "Activity",
            content: (
              <div className="py-4">
                <Timeline
                  items={[
                    {
                      id: "created",
                      actor: "System",
                      timestamp: new Date(lead.createdAt).toLocaleString(),
                      dateTime: lead.createdAt,
                      body: "Lead created.",
                    },
                    {
                      id: "updated",
                      actor: "System",
                      timestamp: new Date(lead.updatedAt).toLocaleString(),
                      dateTime: lead.updatedAt,
                      body: "Lead last updated.",
                    },
                  ]}
                />
              </div>
            ),
          },
        ]}
      />

      <Dialog
        open={convertOpen}
        onOpenChange={setConvertOpen}
        title={`Convert ${displayName(lead)}?`}
        description="Stores the linked record ids and moves the lead to converted. The actual record wiring lands in a later integration pass."
      >
        <form onSubmit={convert} className="flex flex-col gap-3">
          <Field label="Person id" htmlFor="convert-person">
            <TextField
              id="convert-person"
              value={personId}
              onChange={(e) => setPersonId(e.currentTarget.value)}
              placeholder="Optional"
            />
          </Field>
          <Field label="Company id" htmlFor="convert-company">
            <TextField
              id="convert-company"
              value={companyId}
              onChange={(e) => setCompanyId(e.currentTarget.value)}
              placeholder="Optional"
            />
          </Field>
          <Field label="Deal id" htmlFor="convert-deal">
            <TextField
              id="convert-deal"
              value={dealId}
              onChange={(e) => setDealId(e.currentTarget.value)}
              placeholder="Optional"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setConvertOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={convertSaving}>
              {convertSaving ? "Converting…" : "Convert lead"}
            </Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${displayName(lead)}?`}
        description="The lead moves to trash and can be restored."
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  )
}
