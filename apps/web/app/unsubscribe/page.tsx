"use client"

/**
 * Public unsubscribe landing page (spec 24-marketing, P0). Every marketing
 * send carries a link here with `?token=<unsubscribe_token>` — no login,
 * no workspace context, matching `/login` and `/signup` as the other public
 * routes outside `/app`. Possession of the token is the authorization; see
 * `packages/crm/src/marketing/consent-service.ts` for why this one action
 * does not go through the normal session/permission gate.
 */

import { useEffect, useState, type FormEvent } from "react"
import { useSearchParams } from "next/navigation"
import { Button } from "@yourcrm/ui"
import { getClientEnv } from "@/lib/env"

type Status = "idle" | "pending" | "done" | "error"

export default function UnsubscribePage() {
  const searchParams = useSearchParams()
  const token = searchParams.get("token") ?? ""
  const [status, setStatus] = useState<Status>("idle")
  const [message, setMessage] = useState<string | null>(null)

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    if (token.trim() === "") {
      setStatus("error")
      setMessage("This unsubscribe link is missing its token.")
      return
    }
    setStatus("pending")
    try {
      const { NEXT_PUBLIC_API_URL } = getClientEnv()
      const res = await fetch(`${NEXT_PUBLIC_API_URL}/api/v1/marketing/unsubscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      })
      if (!res.ok) {
        setStatus("error")
        setMessage(
          res.status === 404
            ? "This unsubscribe link has already been used or is no longer valid."
            : "Something went wrong. Please try again in a moment.",
        )
        return
      }
      setStatus("done")
    } catch {
      setStatus("error")
      setMessage("Could not reach the server. Please try again.")
    }
  }

  // Unsubscribing is a one-click action from an email link: submit once on
  // load rather than making the recipient find a button.
  useEffect(() => {
    void submit()
    // `submit` reads `token` fresh from `searchParams` on every render;
    // depending on `token` alone (not the closed-over `submit`) is
    // intentional so this only fires once per link, not once per render.
  }, [token])

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-8 text-center">
      {status === "pending" || status === "idle" ? (
        <>
          <h1 className="text-xl font-semibold">Unsubscribing…</h1>
          <p className="mt-2 text-sm text-muted-foreground">One moment.</p>
        </>
      ) : null}
      {status === "done" ? (
        <>
          <h1 className="text-xl font-semibold">You&apos;re unsubscribed</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            You will not receive marketing emails from this workspace going forward.
          </p>
        </>
      ) : null}
      {status === "error" ? (
        <>
          <h1 className="text-xl font-semibold">Could not unsubscribe</h1>
          <p role="alert" className="mt-2 text-sm text-destructive">
            {message}
          </p>
          <Button type="button" className="mt-4" onClick={() => void submit()}>
            Try again
          </Button>
        </>
      ) : null}
    </div>
  )
}
