"use client"

import { useState, type FormEvent } from "react"
import { Button, TextField } from "@yourcrm/ui"
import {
  magicLinkFeedback,
  requestPortalMagicLink,
  PORTAL_GENERIC_LINK_MESSAGE,
} from "../portal-client"

/**
 * Portal sign-in (spec 45-customer-portal, P0).
 *
 * There is no password and no account list. The customer types an address;
 * the API answers 202 whether or not that address has portal access, and
 * this page says the same sentence either way — including when the request
 * fails outright. Do not add "we couldn't find that account": the API went
 * to some trouble not to say it.
 */
export default function PortalLoginPage() {
  const [email, setEmail] = useState("")
  const [message, setMessage] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setPending(true)
    try {
      await requestPortalMagicLink(email.trim())
      setMessage(PORTAL_GENERIC_LINK_MESSAGE)
    } catch (error) {
      // Same sentence for every failure except an explicit rate limit.
      setMessage(magicLinkFeedback(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Sign in to your portal</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter the email address your account manager uses. We will send you a single-use link — no
          password needed.
        </p>
      </div>

      <form className="flex flex-col gap-3" onSubmit={onSubmit} noValidate={false}>
        <label className="flex flex-col gap-1 text-sm" htmlFor="portal-email">
          Email
          <TextField
            id="portal-email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <Button type="submit" disabled={pending || email.trim() === ""}>
          {pending ? "Sending…" : "Email me a sign-in link"}
        </Button>
      </form>

      {message ? (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
    </div>
  )
}
