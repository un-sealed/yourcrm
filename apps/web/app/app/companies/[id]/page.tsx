"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  RecordHeader,
  Select,
  Skeleton,
  Tabs,
  TextArea,
  TextField,
  Timeline,
  toast,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import type { CompanyDetail, CompanyPerson } from "../types"

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
]

type PeopleListResponse = {
  data: CompanyPerson[]
  pagination: { nextCursor: string | null; limit: number }
}

function formatAddress(a: CompanyDetail["addresses"][number]): string {
  return [a.line1, a.city, a.region, a.postalCode, a.country]
    .filter((part) => part !== null && part !== "")
    .join(", ")
}

/** Company detail: header, tabbed overview/people/timeline, inline edit, delete. */
export default function CompanyDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id
  const [company, setCompany] = useState<CompanyDetail | null>(null)
  const [people, setPeople] = useState<CompanyPerson[]>([])
  const [tab, setTab] = useState("overview")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [industry, setIndustry] = useState("")
  const [size, setSize] = useState("")
  const [domain, setDomain] = useState("")
  const [website, setWebsite] = useState("")
  const [status, setStatus] = useState("active")
  const [description, setDescription] = useState("")
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<CompanyDetail>(`/api/v1/companies/${id}`)
      setCompany(data)
      setIndustry(data.industry ?? "")
      setSize(data.size ?? "")
      setDomain(data.domain ?? "")
      setWebsite(data.website ?? "")
      setStatus(data.status)
      setDescription(data.description ?? "")
      // People-at-company list, read via the People API: the P0 people search
      // has no company filter, so fetch a page and keep this company's rows.
      try {
        const res = await apiFetchRaw<PeopleListResponse>("/api/v1/people?limit=200")
        setPeople(res.data.filter((p) => p.companyId === data.id))
      } catch {
        setPeople([])
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this company.")
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
      const updated = await apiFetch<CompanyDetail>(`/api/v1/companies/${id}`, {
        method: "PATCH",
        body: {
          industry: industry.trim() === "" ? null : industry.trim(),
          size: size.trim() === "" ? null : size.trim(),
          domain: domain.trim() === "" ? null : domain.trim(),
          website: website.trim() === "" ? null : website.trim(),
          status,
          description: description.trim() === "" ? null : description.trim(),
        },
      })
      setCompany(updated)
      toast({ title: "Company updated" })
    } catch (err) {
      toast({
        title: "Update failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    try {
      await apiFetch(`/api/v1/companies/${id}`, { method: "DELETE" })
      toast({ title: "Company deleted", description: "It can be restored from trash." })
      router.push("/app/companies")
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading company">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error !== null || company === null) {
    return (
      <ErrorState message={error ?? "This company does not exist."} onRetry={() => void load()} />
    )
  }

  const primaryAddress = company.addresses.find((a) => a.isPrimary) ?? company.addresses[0]

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/companies" className="text-sm text-muted-foreground hover:underline">
        ← Back to companies
      </Link>
      <RecordHeader
        title={company.name}
        subtitle={company.industry ?? "No industry"}
        status={{
          label: company.status,
          tone: company.status === "active" ? "success" : "secondary",
        }}
        owner={undefined}
        actions={
          <>
            {company.website ? (
              <a href={company.website} target="_blank" rel="noreferrer">
                <Button variant="outline" size="sm">
                  Website
                </Button>
              </a>
            ) : null}
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </>
        }
      />

      <Tabs
        value={tab}
        onValueChange={setTab}
        ariaLabel="Company sections"
        items={[
          {
            value: "overview",
            label: "Overview",
            content: (
              <div className="grid gap-6 py-4 lg:grid-cols-2">
                <section aria-label="Company properties" className="flex flex-col gap-3">
                  <h2 className="text-sm font-semibold">Properties</h2>
                  <dl className="flex flex-col gap-2 text-sm">
                    <div className="flex items-center gap-2">
                      <dt className="w-24 shrink-0 text-muted-foreground">Domain</dt>
                      <dd>{company.domain ?? "—"}</dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-24 shrink-0 text-muted-foreground">Industry</dt>
                      <dd>{company.industry ?? "—"}</dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-24 shrink-0 text-muted-foreground">Size</dt>
                      <dd>{company.size ?? "—"}</dd>
                    </div>
                    <div className="flex items-center gap-2">
                      <dt className="w-24 shrink-0 text-muted-foreground">Website</dt>
                      <dd>
                        {company.website ? (
                          <a
                            href={company.website}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary hover:underline"
                          >
                            {company.website}
                          </a>
                        ) : (
                          "—"
                        )}
                      </dd>
                    </div>
                  </dl>
                  {company.description ? (
                    <div className="flex flex-col gap-1">
                      <h3 className="text-sm font-semibold">Description</h3>
                      <p className="whitespace-pre-wrap text-sm">{company.description}</p>
                    </div>
                  ) : null}
                  <div className="flex flex-col gap-1">
                    <h3 className="text-sm font-semibold">Locations</h3>
                    {company.addresses.length === 0 ? (
                      <EmptyState
                        title="No locations"
                        description="Add an address when you create or edit this company."
                      />
                    ) : (
                      <dl className="flex flex-col gap-2 text-sm">
                        {company.addresses.map((address) => (
                          <div key={address.id} className="flex items-center gap-2">
                            <dt className="w-24 shrink-0 text-muted-foreground">
                              {address.label ?? "Address"}
                            </dt>
                            <dd>{formatAddress(address) || "—"}</dd>
                            {address.isPrimary ? <Badge tone="secondary">Primary</Badge> : null}
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                  {primaryAddress && primaryAddress.city ? (
                    <p className="text-xs text-muted-foreground">
                      Map hook: {primaryAddress.city}
                      {primaryAddress.country ? `, ${primaryAddress.country}` : ""} — field-sales
                      routing plugs in here.
                    </p>
                  ) : null}
                  <div className="flex flex-col gap-1">
                    <h3 className="text-sm font-semibold">Child companies</h3>
                    {company.children.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No child accounts.</p>
                    ) : (
                      <ul className="flex flex-col gap-1 text-sm">
                        {company.children.map((child) => (
                          <li key={child.id}>
                            <Link
                              href={`/app/companies/${child.id}`}
                              className="font-medium text-primary hover:underline"
                            >
                              {child.name}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </section>
                <section aria-label="Edit company">
                  <h2 className="mb-3 text-sm font-semibold">Edit</h2>
                  <form onSubmit={save} className="flex flex-col gap-3">
                    <Field label="Domain" htmlFor="company-domain">
                      <TextField
                        id="company-domain"
                        value={domain}
                        onChange={(e) => setDomain(e.currentTarget.value)}
                        placeholder="acme.com"
                      />
                    </Field>
                    <Field label="Website" htmlFor="company-website">
                      <TextField
                        id="company-website"
                        type="url"
                        value={website}
                        onChange={(e) => setWebsite(e.currentTarget.value)}
                        placeholder="https://acme.com"
                      />
                    </Field>
                    <Field label="Industry" htmlFor="company-industry">
                      <TextField
                        id="company-industry"
                        value={industry}
                        onChange={(e) => setIndustry(e.currentTarget.value)}
                        placeholder="Software"
                      />
                    </Field>
                    <Field label="Size" htmlFor="company-size">
                      <TextField
                        id="company-size"
                        value={size}
                        onChange={(e) => setSize(e.currentTarget.value)}
                        placeholder="51-200"
                      />
                    </Field>
                    <Field label="Status" htmlFor="company-status">
                      <Select
                        id="company-status"
                        value={status}
                        onChange={(e) => setStatus(e.currentTarget.value)}
                        options={STATUS_OPTIONS}
                      />
                    </Field>
                    <Field label="Description" htmlFor="company-description">
                      <TextArea
                        id="company-description"
                        value={description}
                        onChange={(e) => setDescription(e.currentTarget.value)}
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
            value: "people",
            label: "People",
            content: (
              <div className="py-4">
                {people.length === 0 ? (
                  <EmptyState
                    title="No people at this company yet"
                    description="Contacts linked to this account appear here."
                  />
                ) : (
                  <ul className="flex flex-col gap-2 text-sm">
                    {people.map((person) => (
                      <li key={person.id} className="flex items-center gap-2">
                        <Link
                          href={`/app/people/${person.id}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {[person.firstName, person.lastName]
                            .filter((part) => part !== null && part !== "")
                            .join(" ")}
                        </Link>
                        {person.title ? (
                          <span className="text-muted-foreground">{person.title}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
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
                      timestamp: new Date(company.createdAt).toLocaleString(),
                      dateTime: company.createdAt,
                      body: "Company created.",
                    },
                    {
                      id: "updated",
                      actor: "System",
                      timestamp: new Date(company.updatedAt).toLocaleString(),
                      dateTime: company.updatedAt,
                      body: "Company last updated.",
                    },
                  ]}
                />
              </div>
            ),
          },
        ]}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${company.name}?`}
        description="The company moves to trash and can be restored."
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  )
}
