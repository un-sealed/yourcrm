"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button, Field, TextField, toast } from "@yourcrm/ui"
import { useUnsavedGuard } from "@/components/use-unsaved-guard"
import { ApiError, apiFetch } from "@/lib/api-client"
import type { WhatsAppConversation } from "../types"

/**
 * Open (or reopen) a conversation with a contact. Free-form text still
 * respects the 24h session window on the thread page — creating a
 * conversation here does not open it; only an inbound message, or a
 * template send, does that.
 */
export default function NewWhatsAppConversationPage() {
  const router = useRouter()
  const [connectionId, setConnectionId] = useState("")
  const [contactPhone, setContactPhone] = useState("")
  const [personId, setPersonId] = useState("")
  const [companyId, setCompanyId] = useState("")
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const dirty = connectionId !== "" || contactPhone !== "" || personId !== "" || companyId !== ""
  useUnsavedGuard(dirty && !saving)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (connectionId.trim() === "" || contactPhone.trim() === "") {
      setFieldError("Connection and contact phone number are required.")
      return
    }
    setFieldError(null)
    setSaving(true)
    try {
      const conversation = await apiFetch<WhatsAppConversation>("/api/v1/whatsapp/conversations", {
        method: "POST",
        body: {
          connectionId: connectionId.trim(),
          contactPhone: contactPhone.trim(),
          ...(personId.trim() === "" ? {} : { personId: personId.trim() }),
          ...(companyId.trim() === "" ? {} : { companyId: companyId.trim() }),
        },
      })
      toast({ title: "Conversation ready", description: contactPhone.trim() })
      router.push(`/app/whatsapp/${conversation.id}`)
    } catch (err) {
      setFieldError(err instanceof ApiError ? err.message : "Could not open the conversation.")
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">New WhatsApp conversation</h1>
        <Link href="/app/whatsapp" className="text-sm text-muted-foreground hover:underline">
          Back to WhatsApp
        </Link>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          label="Connection"
          htmlFor="connection-id"
          required
          hint="The WhatsApp integration connection id (Settings → Integrations)."
          error={fieldError}
        >
          <TextField
            id="connection-id"
            value={connectionId}
            onChange={(e) => setConnectionId(e.currentTarget.value)}
            required
          />
        </Field>
        <Field
          label="Contact phone number"
          htmlFor="contact-phone"
          required
          hint="Any format works — it's normalised to E.164 on save."
        >
          <TextField
            id="contact-phone"
            value={contactPhone}
            onChange={(e) => setContactPhone(e.currentTarget.value)}
            placeholder="+1 415 555 2671"
            required
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Link to person" htmlFor="person-id">
            <TextField
              id="person-id"
              value={personId}
              onChange={(e) => setPersonId(e.currentTarget.value)}
              placeholder="Person id (optional)"
            />
          </Field>
          <Field label="Link to company" htmlFor="company-id">
            <TextField
              id="company-id"
              value={companyId}
              onChange={(e) => setCompanyId(e.currentTarget.value)}
              placeholder="Company id (optional)"
            />
          </Field>
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Open conversation"}
          </Button>
          <Link href="/app/whatsapp" className="text-sm text-muted-foreground hover:underline">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}
