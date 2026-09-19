"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button, Field, Select, TextArea, TextField, toast } from "@yourcrm/ui"
import { useUnsavedGuard } from "@/components/use-unsaved-guard"
import { ApiError, apiFetch } from "@/lib/api-client"
import type { Person } from "../types"

const CHANNEL_OPTIONS = [
  { value: "", label: "None" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "sms", label: "SMS" },
  { value: "whatsapp", label: "WhatsApp" },
]

/** Create-person form: required fields first, advanced fields collapsible. */
export default function NewPersonPage() {
  const router = useRouter()
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [title, setTitle] = useState("")
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [channel, setChannel] = useState("")
  const [notes, setNotes] = useState("")
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const dirty =
    firstName !== "" ||
    lastName !== "" ||
    title !== "" ||
    email !== "" ||
    phone !== "" ||
    notes !== ""
  useUnsavedGuard(dirty && !saving)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (firstName.trim() === "") {
      setFieldError("First name is required.")
      return
    }
    setFieldError(null)
    setSaving(true)
    try {
      const person = await apiFetch<Person>("/api/v1/people", {
        method: "POST",
        body: {
          firstName: firstName.trim(),
          ...(lastName.trim() === "" ? {} : { lastName: lastName.trim() }),
          ...(title.trim() === "" ? {} : { title: title.trim() }),
          ...(channel === "" ? {} : { preferredChannel: channel }),
          ...(notes.trim() === "" ? {} : { notes: notes.trim() }),
          ...(email.trim() === "" ? {} : { emails: [{ email: email.trim(), isPrimary: true }] }),
          ...(phone.trim() === "" ? {} : { phones: [{ phone: phone.trim(), isPrimary: true }] }),
        },
      })
      toast({ title: "Person created", description: `${firstName.trim()} was added.` })
      router.push(`/app/people/${person.id}`)
    } catch (err) {
      setFieldError(err instanceof ApiError ? err.message : "Could not create the person.")
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">New person</h1>
        <Link href="/app/people" className="text-sm text-muted-foreground hover:underline">
          Back to people
        </Link>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" htmlFor="first-name" required error={fieldError}>
            <TextField
              id="first-name"
              value={firstName}
              onChange={(e) => setFirstName(e.currentTarget.value)}
              placeholder="Ada"
              required
              invalid={fieldError !== null && firstName.trim() === ""}
            />
          </Field>
          <Field label="Last name" htmlFor="last-name">
            <TextField
              id="last-name"
              value={lastName}
              onChange={(e) => setLastName(e.currentTarget.value)}
              placeholder="Lovelace"
            />
          </Field>
        </div>
        <Field label="Job title" htmlFor="title">
          <TextField
            id="title"
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            placeholder="Engineer"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email" htmlFor="email">
            <TextField
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              placeholder="ada@example.com"
            />
          </Field>
          <Field label="Phone" htmlFor="phone">
            <TextField
              id="phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.currentTarget.value)}
              placeholder="+1 555 0100"
            />
          </Field>
        </div>
        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
          <div className="mt-3 flex flex-col gap-4">
            <Field label="Preferred channel" htmlFor="channel">
              <Select
                id="channel"
                value={channel}
                onChange={(e) => setChannel(e.currentTarget.value)}
                options={CHANNEL_OPTIONS}
              />
            </Field>
            <Field label="Notes" htmlFor="notes">
              <TextArea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.currentTarget.value)}
                placeholder="Context worth remembering…"
              />
            </Field>
          </div>
        </details>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => router.push("/app/people")}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Create person"}
          </Button>
        </div>
      </form>
    </div>
  )
}
