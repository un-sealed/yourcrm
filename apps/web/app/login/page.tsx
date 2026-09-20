"use client"

/**
 * Login page (Wave-1 auth, spec 04: email+password only).
 * Posts the `@yourcrm/auth` login contract to the API; the API sets the
 * httpOnly `yourcrm_session` cookie. Until the platform-seams agent mounts
 * `POST /api/v1/auth/login`, submissions surface the API error state below.
 */

import { useState, type FormEvent } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button } from "@yourcrm/ui"
import { getClientEnv } from "@/lib/env"

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setPending(true)
    try {
      const { NEXT_PUBLIC_API_URL } = getClientEnv()
      const res = await fetch(`${NEXT_PUBLIC_API_URL}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: email.trim(), password }),
      })
      if (!res.ok) {
        // Credential failures are deliberately generic. Server faults are
        // NOT: reporting a 500 as "invalid password" sends people hunting
        // for a typo when the API is actually misconfigured or down.
        setError(
          res.status >= 500
            ? "The server hit an error. Check the API logs and try again."
            : "Invalid email or password.",
        )
        return
      }
      router.push("/app/dashboard")
      router.refresh()
    } catch {
      setError("Could not reach the API. Is it running?")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-8">
      <h1 className="text-2xl font-semibold">Log in to YourCRM</h1>
      <p className="mt-1 text-sm text-muted-foreground">Welcome back to your workspace.</p>
      <form className="mt-6 flex flex-col gap-3" onSubmit={onSubmit}>
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            className="rounded-md border bg-transparent px-3 py-2 text-sm"
            placeholder="you@company.com"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            className="rounded-md border bg-transparent px-3 py-2 text-sm"
            placeholder="Password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Logging in…" : "Log in"}
        </Button>
      </form>
      <p className="mt-4 text-sm text-muted-foreground">
        No account?{" "}
        <Link href="/signup" className="underline">
          Sign up
        </Link>
      </p>
    </div>
  )
}
