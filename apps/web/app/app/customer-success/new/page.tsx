"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button, DatePicker, Field, Select, TextField, toast } from "@yourcrm/ui"
import { useUnsavedGuard } from "@/components/use-unsaved-guard"
import { ApiError, apiFetch } from "@/lib/api-client"
import { CS_LIFECYCLE_OPTIONS, type CsAccount } from "../types"

/** Create-account form: required fields first, advanced fields collapsible. */
export default function NewCustomerSuccessAccountPage() {
  const router = useRouter()
  const [companyId, setCompanyId] = useState("")
  const [lifecycleStage, setLifecycleStage] = useState("onboarding")
  const [arr, setArr] = useState("")
  const [renewalDate, setRenewalDate] = useState("")
  const [ownerId, setOwnerId] = useState("")
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const dirty = companyId !== "" || arr !== "" || renewalDate !== "" || ownerId !== ""
  useUnsavedGuard(dirty && !saving)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (companyId.trim() === "") {
      setFieldError("Company is required.")
      return
    }
    setFieldError(null)
    setSaving(true)
    try {
      const account = await apiFetch<CsAccount>("/api/v1/customer-success/accounts", {
        method: "POST",
        body: {
          companyId: companyId.trim(),
          lifecycleStage,
          ...(arr.trim() === "" ? {} : { arr: Number(arr) }),
          ...(renewalDate.trim() === "" ? {} : { renewalDate }),
          ...(ownerId.trim() === "" ? {} : { ownerId: ownerId.trim() }),
        },
      })
      toast({ title: "Account created" })
      router.push(`/app/customer-success/${account.id}`)
    } catch (err) {
      setFieldError(err instanceof ApiError ? err.message : "Could not create the account.")
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">New customer success account</h1>
        <Link
          href="/app/customer-success"
          className="text-sm text-muted-foreground hover:underline"
        >
          Back to accounts
        </Link>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Company ID" htmlFor="company-id" required error={fieldError}>
          <TextField
            id="company-id"
            value={companyId}
            onChange={(e) => setCompanyId(e.currentTarget.value)}
            placeholder="Company record id"
            required
            invalid={fieldError !== null && companyId.trim() === ""}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Lifecycle stage" htmlFor="lifecycle-stage">
            <Select
              id="lifecycle-stage"
              value={lifecycleStage}
              onChange={(e) => setLifecycleStage(e.currentTarget.value)}
              options={CS_LIFECYCLE_OPTIONS}
            />
          </Field>
          <Field label="ARR" htmlFor="arr">
            <TextField
              id="arr"
              type="number"
              min="0"
              step="0.01"
              value={arr}
              onChange={(e) => setArr(e.currentTarget.value)}
              placeholder="120000"
            />
          </Field>
        </div>
        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="Renewal date" htmlFor="renewal-date">
              <DatePicker
                id="renewal-date"
                value={renewalDate}
                onChange={(e) => setRenewalDate(e.currentTarget.value)}
              />
            </Field>
            <Field label="Owner (CSM) ID" htmlFor="owner-id">
              <TextField
                id="owner-id"
                value={ownerId}
                onChange={(e) => setOwnerId(e.currentTarget.value)}
                placeholder="User id"
              />
            </Field>
          </div>
        </details>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push("/app/customer-success")}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Create account"}
          </Button>
        </div>
      </form>
    </div>
  )
}
