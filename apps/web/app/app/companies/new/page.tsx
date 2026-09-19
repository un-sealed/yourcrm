"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button, Field, Select, TextArea, TextField, toast } from "@yourcrm/ui"
import { useUnsavedGuard } from "@/components/use-unsaved-guard"
import { ApiError, apiFetch } from "@/lib/api-client"
import type { Company } from "../types"

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
]

/** Create-company form: required fields first, advanced fields collapsible. */
export default function NewCompanyPage() {
  const router = useRouter()
  const [name, setName] = useState("")
  const [domain, setDomain] = useState("")
  const [website, setWebsite] = useState("")
  const [industry, setIndustry] = useState("")
  const [size, setSize] = useState("")
  const [status, setStatus] = useState("active")
  const [description, setDescription] = useState("")
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const dirty =
    name !== "" ||
    domain !== "" ||
    website !== "" ||
    industry !== "" ||
    size !== "" ||
    description !== ""
  useUnsavedGuard(dirty && !saving)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (name.trim() === "") {
      setFieldError("Company name is required.")
      return
    }
    setFieldError(null)
    setSaving(true)
    try {
      const company = await apiFetch<Company>("/api/v1/companies", {
        method: "POST",
        body: {
          name: name.trim(),
          ...(domain.trim() === "" ? {} : { domain: domain.trim() }),
          ...(website.trim() === "" ? {} : { website: website.trim() }),
          ...(industry.trim() === "" ? {} : { industry: industry.trim() }),
          ...(size.trim() === "" ? {} : { size: size.trim() }),
          status,
          ...(description.trim() === "" ? {} : { description: description.trim() }),
        },
      })
      toast({ title: "Company created", description: `${name.trim()} was added.` })
      router.push(`/app/companies/${company.id}`)
    } catch (err) {
      setFieldError(err instanceof ApiError ? err.message : "Could not create the company.")
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">New company</h1>
        <Link href="/app/companies" className="text-sm text-muted-foreground hover:underline">
          Back to companies
        </Link>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Company name" htmlFor="name" required error={fieldError}>
          <TextField
            id="name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder="Acme Inc."
            required
            invalid={fieldError !== null && name.trim() === ""}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Domain" htmlFor="domain">
            <TextField
              id="domain"
              value={domain}
              onChange={(e) => setDomain(e.currentTarget.value)}
              placeholder="acme.com"
            />
          </Field>
          <Field label="Website" htmlFor="website">
            <TextField
              id="website"
              type="url"
              value={website}
              onChange={(e) => setWebsite(e.currentTarget.value)}
              placeholder="https://acme.com"
            />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Industry" htmlFor="industry">
            <TextField
              id="industry"
              value={industry}
              onChange={(e) => setIndustry(e.currentTarget.value)}
              placeholder="Software"
            />
          </Field>
          <Field label="Size" htmlFor="size">
            <TextField
              id="size"
              value={size}
              onChange={(e) => setSize(e.currentTarget.value)}
              placeholder="51-200"
            />
          </Field>
        </div>
        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
          <div className="mt-3 flex flex-col gap-4">
            <Field label="Status" htmlFor="status">
              <Select
                id="status"
                value={status}
                onChange={(e) => setStatus(e.currentTarget.value)}
                options={STATUS_OPTIONS}
              />
            </Field>
            <Field label="Description" htmlFor="description">
              <TextArea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                placeholder="What does this company do…"
              />
            </Field>
          </div>
        </details>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => router.push("/app/companies")}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Create company"}
          </Button>
        </div>
      </form>
    </div>
  )
}
